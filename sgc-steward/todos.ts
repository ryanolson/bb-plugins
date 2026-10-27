// The owner's todo list on the server: read with every poll, shown on the
// page and by `bb sgc todos`, and marked done, or reopened, from either.
//
// A Done or an Undo is kept before it writes to Linear. It then posts its
// comment under its own id and makes its change, under the plugin's one
// lock. A write whose reply was lost may still have landed, so only a fresh
// read of the issue decides what is done. What a failed write leaves, the
// owner's retry finishes; what a lost reply or a restart leaves after both
// writes landed, the next poll finishes. Four rules keep the steward's
// messages right through any failure or restart:
//
// - Each action is one row that holds its message, and the thread it goes
//   to, from the start. A retry changes neither.
// - Finishing the row and keeping its message to send are one transaction.
//   Giving it up is one delete, before any message exists.
// - Every Undo attempt first checks that its Done is the latest on the
//   issue, and that the issue is as that Done left it. Otherwise it writes
//   nothing.
// - Messages go out one at a time, in the order their actions finished. On
//   one issue, an action finishes or is given up before the next begins. A
//   send that fails waits for the owner's retry, so it can arrive late.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PluginCliError, cliCommand, experimental_PluginRpcRefusal, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Delivery } from "./lib/ask-store.ts";
import type { TodoView, rpcContract } from "./lib/contract.ts";
import { formatTodos } from "./lib/format.ts";
import { HUMAN_LABEL, TODO_LABEL, postComment, type LinearClient, type TodoIssue } from "./lib/linear.ts";
import { Refusal } from "./lib/refusal.ts";
import { createTodoStore, type TodoAction } from "./lib/todo-store.ts";
import { TODO_NOTE_CHARS, checkNote, checklist, doneComment, hasLabel, isTodo, reopenedComment, todoDoneMessage, todoReopenedMessage } from "./lib/todos.ts";

/** How long the page can undo a Done, and how many undos the plugin keeps. */
const UNDO_MS = 60 * 60 * 1000;
const UNDO_LIMIT = 100;
/** How long finished actions are kept before they are forgotten. */
const FINISHED_MS = 24 * 60 * 60 * 1000;

export type StewardTold = "sent" | "failed" | "skipped";

export interface TodoDeps {
  db: Database.Database;
  /** How long a post can take: an action whose comment is still missing after this is given up. */
  postWindowMs: number;
  /** Run Linear writes ahead of any poll, under the plugin's one lock. Errors come back without the key. */
  write<T>(work: (linear: LinearClient, teamKey: string) => Promise<T>): Promise<T>;
  /** The steward thread to tell, or null when none is set or bb reports it gone. */
  steward(): Promise<string | null>;
  /** Keep a finished action's message to send, in the caller's transaction. Returns it to send, once; null when it was kept before. */
  keep(message: { ref: string; threadId: string; label: string; message: string }): Delivery | null;
  /** Send a kept message, once. */
  send(row: Delivery): Promise<"sent" | "failed">;
  /** Drop what the poller cached about an issue that just changed. */
  forget(issueId: string): void;
  /** Tell open pages that the list changed. */
  publish(): void;
  /** Poll now, for a caller that waits. */
  refresh(): Promise<void>;
  /** Whether the Linear API key is set. */
  configured(): boolean;
  log(text: string): void;
}

/** What undoing one Done puts back, and what the Done left, so Undo can tell that the issue changed since. */
interface Undo {
  issueId: string;
  identifier: string;
  title: string;
  restore: { change: TodoAction["change"]; id: string };
  after: { stateId: string | null; labelIds: string[] };
  at: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toView(issue: TodoIssue): TodoView {
  return { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, human: hasLabel(issue, HUMAN_LABEL), steps: checklist(issue.description) };
}

/** Oldest first, by the number in the identifier. */
function byNumber(a: TodoView, b: TodoView): number {
  const number = (todo: TodoView) => Number(todo.identifier.split("-").at(-1));
  return number(a) - number(b) || a.identifier.localeCompare(b.identifier);
}

function refusal(error: unknown): never {
  if (error instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
  throw error;
}

/** A Done takes the issue off the list, and an Undo puts it back. Anything else that does the same counts too. */
function landed(action: Pick<TodoAction, "kind">, issue: TodoIssue): boolean {
  return action.kind === "done" ? !isTodo(issue) : isTodo(issue);
}

/** The state and labels a Done leaves on the issue it reads, as Undo expects to find them. */
function leftBy(action: Pick<TodoAction, "change" | "targetId">, issue: TodoIssue): Undo["after"] {
  const labelIds = issue.labels.map((label) => label.id);
  return action.change === "state"
    ? { stateId: action.targetId, labelIds }
    : { stateId: issue.state?.id ?? null, labelIds: labelIds.filter((id) => id !== action.targetId) };
}

/** Whether the issue is as its Done left it: the same state and the same labels. */
function unchangedSince(issue: TodoIssue, after: Undo["after"]): boolean {
  const labels = issue.labels.map((label) => label.id).sort();
  const expected = [...after.labelIds].sort();
  return (issue.state?.id ?? null) === after.stateId && labels.length === expected.length && labels.every((id, index) => id === expected[index]);
}

function messageLabel(action: Pick<TodoAction, "kind" | "identifier">): string {
  return `${action.kind === "done" ? "Todo done" : "Todo reopened"} ${action.identifier}`;
}

export function createTodos(deps: TodoDeps) {
  const store = createTodoStore(deps.db);
  let todos: TodoView[] = [];
  let todoError: string | null = null;
  /** Undos for the Dones of this plugin load, by their comment id: the page's undo. */
  const undos = new Map<string, Undo>();
  /** The last message sent or waiting to send. Each send waits for the one before it; none rejects. */
  let queue: Promise<StewardTold> = Promise.resolve("skipped");

  function send(row: Delivery): Promise<StewardTold> {
    queue = queue.then(() => deps.send(row)).catch(() => "failed" as const);
    return queue;
  }

  /**
   * Finish an action: one transaction marks it finished and keeps its
   * message for the thread named when it began. The send joins the queue at
   * once, under the lock, so the steward hears in the order actions finish.
   * `told` is wrapped so that no caller awaits it under the lock by mistake.
   */
  function finish(action: TodoAction): { told: Promise<StewardTold> } {
    const kept = deps.db.transaction(() =>
      store.finish(action.id) && action.recipient !== null
        ? deps.keep({ ref: action.id, threadId: action.recipient, label: messageLabel(action), message: action.message })
        : null,
    )();
    deps.forget(action.issueId);
    // Undo reverses the latest Done of an issue only, so each Done, however it
    // finished, retires the undos of the Dones before it.
    if (action.kind === "done") for (const [token, undo] of undos) if (undo.issueId === action.issueId) undos.delete(token);
    return { told: kept === null ? Promise.resolve<StewardTold>("skipped") : send(kept) };
  }

  async function applyChange(linear: LinearClient, action: TodoAction): Promise<void> {
    if (action.change === "state") await linear.setState({ issueId: action.issueId, stateId: action.targetId });
    else if (action.kind === "done") await linear.removeLabel({ issueId: action.issueId, labelId: action.targetId });
    else await linear.addLabel({ issueId: action.issueId, labelId: action.targetId });
  }

  /**
   * Carry an action through, under the lock: its comment under its own id,
   * then its change unless Linear holds it already. A change whose reply was
   * lost may have landed, so after a failure only a fresh read decides.
   * Throws, leaving the action unfinished, when Linear lacks either write.
   */
  async function carry(linear: LinearClient, action: TodoAction, issue: TodoIssue): Promise<{ told: Promise<StewardTold> }> {
    const again = action.kind === "done" ? "Press Done again to finish it." : "Press Undo again to finish it.";
    try {
      await postComment(linear, action.issueId, action.body, action.id);
    } catch (error) {
      throw new Error(`Could not post the comment on ${action.identifier}: ${message(error)} ${again}`);
    }
    if (!landed(action, issue)) {
      try {
        await applyChange(linear, action);
      } catch (error) {
        const now = await linear.getTodoIssue(action.issueId).catch(() => null);
        if (now === null || !landed(action, now)) {
          throw new Error(`The comment is posted on ${action.identifier}, but Linear did not take the change: ${message(error)} ${again}`);
        }
      }
    }
    return finish(action);
  }

  /**
   * Settle the unfinished action of one kind on an issue, writing nothing to
   * Linear: finish it when Linear holds its comment and its change, else
   * give it up. Null when it did not finish.
   */
  async function resolve(linear: LinearClient, issue: TodoIssue, kind: TodoAction["kind"]): Promise<{ told: Promise<StewardTold> } | null> {
    const action = store.pending(issue.id, kind);
    if (action === null) return null;
    const comments = await linear.listComments(issue.id, undefined, issue.identifier);
    if (comments.some((comment) => comment.id === action.id) && landed(action, issue)) return finish(action);
    store.abandon(action.id);
    return null;
  }

  /** An Undo left unfinished can be retried only from a page that still holds an undo for its issue. */
  function retryable(action: TodoAction): boolean {
    return [...undos.values()].some((undo) => undo.issueId === action.issueId && Date.now() - undo.at <= UNDO_MS);
  }

  /**
   * Finish what a lost reply or a restart left: an action whose comment and
   * change Linear both holds. This writes nothing to Linear. An action still
   * short of either waits for the owner's retry, unless it can never finish:
   * its issue is gone, its comment is still missing after the post window,
   * or it is an Undo that no page can retry any more.
   */
  async function settle(linear: LinearClient, signal: AbortSignal): Promise<void> {
    for (const action of store.unfinished()) {
      let issue: TodoIssue | null;
      let posted = false;
      try {
        issue = await linear.getTodoIssue(action.issueId, signal);
        if (issue !== null) posted = (await linear.listComments(issue.id, signal, issue.identifier)).some((comment) => comment.id === action.id);
      } catch {
        if (signal.aborted) return;
        continue;
      }
      if (issue !== null && posted && landed(action, issue)) {
        finish(action);
        continue;
      }
      const why =
        issue === null
          ? "its issue is gone"
          : !posted && Date.now() - action.attemptedAt >= deps.postWindowMs
            ? "its comment never reached Linear"
            : posted && action.kind === "reopen" && !retryable(action)
              ? "no page can retry it, so its Reopened comment may stand without the change"
              : null;
      if (why === null) continue;
      store.abandon(action.id);
      deps.log(`gave up the ${action.kind === "done" ? "Done" : "Undo"} of ${action.identifier}: ${why}`);
    }
    store.prune(FINISHED_MS);
  }

  /**
   * Read the todo list, inside the poll, under its lock and signal, after
   * settling what earlier actions left. A failed read keeps the list from
   * the read before and records why; it does not fail the poll of the
   * questions. Null when the poll was stopped.
   */
  async function poll(linear: LinearClient, teamKey: string, notify: boolean, signal: AbortSignal): Promise<{ fresh: number; changed: boolean } | null> {
    await settle(linear, signal);
    if (signal.aborted) return null;
    const before = JSON.stringify([todos, todoError]);
    try {
      const listed = await linear.listTodoIssues(teamKey, signal);
      if (signal.aborted) return null;
      todos = listed.filter(isTodo).map(toView).sort(byNumber);
      todoError = null;
    } catch (error) {
      if (signal.aborted) return null;
      todoError = message(error);
      return { fresh: 0, changed: JSON.stringify([todos, todoError]) !== before };
    }
    const fresh = store.reconcileSeen(todos, notify);
    return { fresh, changed: JSON.stringify([todos, todoError]) !== before };
  }

  function remember(token: string, undo: Undo): void {
    const now = Date.now();
    for (const [key, entry] of undos) if (now - entry.at > UNDO_MS) undos.delete(key);
    undos.set(token, undo);
    while (undos.size > UNDO_LIMIT) undos.delete(undos.keys().next().value!);
  }

  /**
   * Mark a todo done: one comment from the owner, then the human issue to
   * Done, or the todo label off any other. A Done that did not finish is
   * finished first, with its own comment, note, and steward thread, so a
   * retry never posts a second comment or tells a second thread.
   */
  async function done(issueRef: string, noteText: string) {
    let note: string | null;
    try {
      note = checkNote(noteText);
    } catch (error) {
      throw new Refusal("invalid", message(error));
    }
    const steward = await deps.steward();
    const { action, told, resumed } = await deps.write(async (linear, teamKey) => {
      const issue = await linear.getTodoIssue(issueRef);
      if (issue === null) throw new Refusal("not_found", `Linear has no issue ${issueRef}.`);
      if (issue.teamKey !== teamKey) throw new Refusal("invalid", `${issue.identifier} is not in team ${teamKey}.`);
      // An earlier Undo finishes, or is given up, before this Done begins.
      await resolve(linear, issue, "reopen");
      let action = store.pending(issue.id, "done");
      const resumed = action !== null;
      if (action !== null) {
        store.attempt(action.id);
      } else {
        if (!isTodo(issue)) throw new Refusal("conflict", `${issue.identifier} is not on the todo list; it may be done already.`);
        // Read everything Done needs before writing anything.
        const human = hasLabel(issue, HUMAN_LABEL);
        const doneState = human ? await linear.doneStateId(teamKey) : null;
        if (human && (doneState === null || issue.state === null)) throw new Refusal("conflict", `Team ${teamKey} has no Done state to move ${issue.identifier} to.`);
        // Not human, so the todo label is what made it a todo.
        const label = issue.labels.find((candidate) => candidate.name === TODO_LABEL);
        const begun: Omit<TodoAction, "attemptedAt"> = {
          id: randomUUID(),
          kind: "done",
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          body: doneComment(note),
          note,
          change: human ? "state" : "label",
          targetId: human ? doneState! : label!.id,
          restoreId: human ? issue.state!.id : label!.id,
          recipient: steward,
          message: todoDoneMessage(issue.identifier, issue.title, note),
        };
        store.begin(begun);
        action = { ...begun, attemptedAt: Date.now() };
      }
      const { told } = await carry(linear, action, issue);
      // Under the lock, right after the finish retired the older undos.
      remember(action.id, {
        issueId: action.issueId,
        identifier: action.identifier,
        title: action.title,
        restore: { change: action.change, id: action.restoreId! },
        after: leftBy(action, issue),
        at: Date.now(),
      });
      todos = todos.filter((todo) => todo.id !== issue.id);
      deps.publish();
      return { action, told, resumed };
    });
    return { identifier: action.identifier, commentId: action.id, change: action.change, steward: await told, undo: action.id, resumed };
  }

  /** The undo of a token: one of the last hour, for the latest Done of its issue. Null once retired or expired. */
  function undoFor(token: string): Undo | null {
    const undo = undos.get(token);
    return undo === undefined || Date.now() - undo.at > UNDO_MS ? null : undo;
  }

  /** Undo a Done of this plugin load: one comment from the owner, then the state or the todo label back. */
  async function reopen(token: string) {
    const gone = () => new Refusal("not_found", "That Done can no longer be undone here. Reopen the issue in Linear.");
    const undo = undoFor(token);
    if (undo === null) throw gone();
    const steward = await deps.steward();
    const { told } = await deps.write(async (linear, teamKey) => {
      const issue = await linear.getTodoIssue(undo.issueId);
      if (issue === null) throw new Refusal("not_found", `Linear has no issue ${undo.identifier}.`);
      // The team is checked before anything else, a resumed Undo included: an undo never writes outside it.
      if (issue.teamKey !== teamKey) throw new Refusal("invalid", `${issue.identifier} is not in team ${teamKey}, so this plugin does not reopen it.`);
      // An earlier Done finishes, or is given up, before this Undo begins.
      await resolve(linear, issue, "done");
      // Checked again before any write: a newer Done, finished while this
      // call waited for the lock or by resolve just now, retired this undo.
      if (undoFor(token) === null) throw gone();
      let finished: { told: Promise<StewardTold> } | null;
      if (!unchangedSince(issue, undo.after)) {
        // Undo reverses its own Done only, so it writes nothing once the issue
        // changed: a later change by anyone else, a cancellation say, stays.
        // This holds for a retry too. An earlier Undo that Linear already
        // holds, its reply lost, finishes here; any other is given up.
        finished = await resolve(linear, issue, "reopen");
        if (finished === null) throw new Refusal("conflict", `${issue.identifier} changed after it was marked done, so Undo leaves it alone. Reopen it in Linear.`);
      } else {
        let action = store.pending(issue.id, "reopen");
        if (action !== null) {
          store.attempt(action.id);
        } else {
          const begun: Omit<TodoAction, "attemptedAt"> = {
            id: randomUUID(),
            kind: "reopen",
            issueId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            body: reopenedComment(),
            note: null,
            change: undo.restore.change,
            targetId: undo.restore.id,
            restoreId: null,
            recipient: steward,
            message: todoReopenedMessage(issue.identifier, issue.title),
          };
          store.begin(begun);
          action = { ...begun, attemptedAt: Date.now() };
        }
        finished = await carry(linear, action, issue);
      }
      undos.delete(token);
      // The Undo is finished whatever this read does; a failed one leaves the list to the next poll.
      const back = await linear.getTodoIssue(issue.id).catch(() => null);
      if (back !== null && isTodo(back)) todos = [...todos.filter((todo) => todo.id !== back.id), toView(back)].sort(byNumber);
      deps.publish();
      return finished;
    });
    return { identifier: undo.identifier, steward: await told };
  }

  const rpc = {
    "todos.done": ({ issue, note }) => done(issue, note).catch(refusal),
    "todos.reopen": ({ undo }) => reopen(undo).catch(refusal),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "todos.done" | "todos.reopen">;

  const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
  const commands = {
    todos: cliCommand({
      summary: "List the owner's todos: open issues that wait on an action only the owner can take",
      description: `Lists open issues on the team with the ${TODO_LABEL} label, and the owner's own issues with the ${HUMAN_LABEL} label. Polls Linear first, unless --cached. Exits 1 when Linear is not set up or the todos could not be read.`,
      options: { json, cached: { type: "boolean", description: "Print the last poll's todos without reading Linear" } },
      async run(input) {
        if (!input.options.cached) await deps.refresh();
        const failures = [
          ...(deps.configured() ? [] : ["The Linear API key is not set, so the todos are not read."]),
          ...(todoError === null ? [] : [`Could not read the todos: ${todoError}`]),
        ];
        return {
          exitCode: failures.length > 0 ? 1 : 0,
          stdout: input.options.json ? JSON.stringify({ todos, todoError }) : formatTodos(todos),
          ...(failures.length > 0 ? { stderr: failures.join("\n") } : {}),
        };
      },
    }),
    "todo done": cliCommand({
      summary: "Mark a todo done: comment on the issue, then move it to Done or remove the todo label",
      description: `Posts "Done (from the SGC page)" and the note as the owner. A ${HUMAN_LABEL} issue moves to the team's Done state; any other loses the ${TODO_LABEL} label and keeps its state. The steward thread gets a message. When an earlier Done of the issue did not finish, this finishes it, with that Done's own comment, note, and steward thread.`,
      positionals: [{ name: "issue", description: "Issue identifier, like TEAM-12", required: true }],
      options: { note: { type: "string", description: `A note for the comment and the steward, at most ${TODO_NOTE_CHARS} characters` }, json },
      async run(input) {
        let result: Awaited<ReturnType<typeof done>>;
        try {
          result = await done(input.positionals.issue, input.options.note ?? "");
        } catch (error) {
          if (error instanceof Refusal) throw new PluginCliError(error.message, { code: error.code });
          throw new PluginCliError(message(error), { code: "linear_error" });
        }
        const change = result.change === "state" ? "moved it to Done" : `removed the ${TODO_LABEL} label`;
        const lead = result.resumed ? `Finished the earlier Done of ${result.identifier}, with its own note` : `Marked ${result.identifier} done`;
        const told = {
          sent: "Told the steward.",
          failed: "Could not tell the steward. Retry it on the SGC questions page.",
          skipped: "Did not tell the steward: no steward thread is set, or it is archived or gone.",
        }[result.steward];
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : `${lead}: ${change}.\n${told}` };
      },
    }),
  };

  return {
    poll,
    /** Resolves once every message queued so far was sent, or failed. */
    sent: async () => void (await queue),
    claim: () => store.claimSeen(),
    list: () => ({ todos, todoError }),
    rpc,
    commands,
  };
}
