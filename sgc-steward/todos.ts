// The owner's todo list on the server: read with every poll, shown on the
// page and by `bb sgc todos`, and marked done, or reopened, from either.
//
// Done changes Linear under the plugin's one lock and reads the issue again
// first, so two Done clicks at once act once. The steward hears after Linear
// has changed, from the call that changed it.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PluginCliError, cliCommand, experimental_PluginRpcRefusal, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TodoView, rpcContract } from "./lib/contract.ts";
import { formatTodos } from "./lib/format.ts";
import { HUMAN_LABEL, TODO_LABEL, postComment, type LinearClient, type TodoIssue } from "./lib/linear.ts";
import { Refusal } from "./lib/refusal.ts";
import { TODO_NOTE_CHARS, checkNote, checklist, doneComment, hasLabel, isTodo, reopenedComment, todoDoneMessage, todoReopenedMessage } from "./lib/todos.ts";

/** How long the page can undo a Done, and how many undos the plugin keeps. */
const UNDO_MS = 60 * 60 * 1000;
const UNDO_LIMIT = 100;

export type StewardTold = "sent" | "failed" | "skipped";

export interface TodoDeps {
  db: Database.Database;
  /** Run Linear writes ahead of any poll, under the plugin's one lock. Errors come back without the key. */
  write<T>(work: (linear: LinearClient, teamKey: string) => Promise<T>): Promise<T>;
  /** Keep a message for the steward thread and send it once; skipped when none is set or bb reports it gone. */
  tellSteward(ref: string, label: string, text: string): Promise<StewardTold>;
  /** Drop what the poller cached about an issue that just changed. */
  forget(issueId: string): void;
  /** Tell open pages that the list changed. */
  publish(): void;
  /** Poll now, for a caller that waits. */
  refresh(): Promise<void>;
  /** Whether the Linear API key is set. */
  configured(): boolean;
}

/** What undoing one Done puts back. */
interface Undo {
  issueId: string;
  identifier: string;
  title: string;
  restore: { kind: "state"; stateId: string } | { kind: "label"; labelId: string };
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

export function createTodos(deps: TodoDeps) {
  const { db } = deps;
  let todos: TodoView[] = [];
  let todoError: string | null = null;
  /** Undos for the Dones of this plugin load, by their comment id: the page's undo. */
  const undos = new Map<string, Undo>();

  /** Record the todos seen; returns how many are new and still to announce. A todo that leaves the list is forgotten, so one that comes back is new. */
  function reconcile(notify: boolean): number {
    const now = Date.now();
    const known = new Set((db.prepare("SELECT issue_id FROM seen_todos").all() as Array<{ issue_id: string }>).map((row) => row.issue_id));
    const current = new Set(todos.map((todo) => todo.id));
    const insert = db.prepare("INSERT INTO seen_todos (issue_id, identifier, title, first_seen_at, notified_at) VALUES (?, ?, ?, ?, ?)");
    const remove = db.prepare("DELETE FROM seen_todos WHERE issue_id = ?");
    let fresh = 0;
    db.transaction(() => {
      for (const todo of todos) {
        if (known.has(todo.id)) continue;
        insert.run(todo.id, todo.identifier, todo.title, now, notify ? null : now);
        if (notify) fresh += 1;
      }
      for (const id of known) if (!current.has(id)) remove.run(id);
    })();
    return fresh;
  }

  /**
   * Read the todo list, inside the poll, under its lock and signal. A failed
   * read keeps the list from the read before and records why; it does not
   * fail the poll of the questions. Null when the poll was stopped.
   */
  async function poll(linear: LinearClient, teamKey: string, notify: boolean, signal: AbortSignal): Promise<{ fresh: number; changed: boolean } | null> {
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
    const fresh = reconcile(notify);
    return { fresh, changed: JSON.stringify([todos, todoError]) !== before };
  }

  /** Todos no window has announced yet, oldest first; each is handed out once. */
  function claim(): Array<{ at: number; id: string; label: string; preview: string }> {
    const rows = db
      .prepare("UPDATE seen_todos SET notified_at = ? WHERE notified_at IS NULL RETURNING issue_id, identifier, title, first_seen_at")
      .all(Date.now()) as Array<{ issue_id: string; identifier: string; title: string; first_seen_at: number }>;
    return rows.map((row) => ({ at: row.first_seen_at, id: row.issue_id, label: row.identifier, preview: row.title }));
  }

  function remember(token: string, undo: Undo): void {
    const now = Date.now();
    for (const [key, entry] of undos) if (now - entry.at > UNDO_MS) undos.delete(key);
    undos.set(token, undo);
    while (undos.size > UNDO_LIMIT) undos.delete(undos.keys().next().value!);
  }

  /**
   * Mark a todo done: one comment from the owner, then the human issue to
   * Done, or the todo label off any other. Each Done posts under its own id:
   * a todo can come back and be done again.
   */
  async function done(issueRef: string, noteText: string) {
    let note: string | null;
    try {
      note = checkNote(noteText);
    } catch (error) {
      throw new Refusal("invalid", message(error));
    }
    const changed = await deps.write(async (linear, teamKey) => {
      const issue = await linear.getTodoIssue(issueRef);
      if (issue === null) throw new Refusal("not_found", `Linear has no issue ${issueRef}.`);
      if (issue.teamKey !== teamKey) throw new Refusal("invalid", `${issue.identifier} is not in team ${teamKey}.`);
      if (!isTodo(issue)) throw new Refusal("conflict", `${issue.identifier} is not on the todo list; it may be done already.`);
      // Read everything Done needs before writing anything.
      const human = hasLabel(issue, HUMAN_LABEL);
      const doneState = human ? await linear.doneStateId(teamKey) : null;
      if (human && (doneState === null || issue.state === null)) throw new Refusal("conflict", `Team ${teamKey} has no Done state to move ${issue.identifier} to.`);
      const label = issue.labels.find((candidate) => candidate.name === TODO_LABEL);
      const commentId = randomUUID();
      await postComment(linear, issue.id, doneComment(note), commentId);
      let restore: Undo["restore"];
      if (human) {
        await linear.setState({ issueId: issue.id, stateId: doneState! });
        restore = { kind: "state", stateId: issue.state!.id };
      } else {
        // Not human, so the todo label is what made it a todo.
        await linear.removeLabel({ issueId: issue.id, labelId: label!.id });
        restore = { kind: "label", labelId: label!.id };
      }
      deps.forget(issue.id);
      todos = todos.filter((todo) => todo.id !== issue.id);
      deps.publish();
      return { issue, commentId, restore };
    });
    const { issue, commentId, restore } = changed;
    remember(commentId, { issueId: issue.id, identifier: issue.identifier, title: issue.title, restore, at: Date.now() });
    const steward = await deps.tellSteward(commentId, `Todo done ${issue.identifier}`, todoDoneMessage(issue.identifier, issue.title, note));
    return { identifier: issue.identifier, commentId, change: restore.kind, steward, undo: commentId };
  }

  /** Undo a Done of this plugin load: one comment from the owner, then the state or the todo label back. */
  async function reopen(token: string) {
    const undo = undos.get(token);
    if (undo === undefined || Date.now() - undo.at > UNDO_MS) {
      throw new Refusal("not_found", "That Done can no longer be undone here. Reopen the issue in Linear.");
    }
    const commentId = await deps.write(async (linear) => {
      const issue = await linear.getTodoIssue(undo.issueId);
      if (issue === null) throw new Refusal("not_found", `Linear has no issue ${undo.identifier}.`);
      if (isTodo(issue)) throw new Refusal("conflict", `${issue.identifier} is on the todo list already.`);
      const id = randomUUID();
      await postComment(linear, issue.id, reopenedComment(), id);
      if (undo.restore.kind === "state") await linear.setState({ issueId: issue.id, stateId: undo.restore.stateId });
      else await linear.addLabel({ issueId: issue.id, labelId: undo.restore.labelId });
      undos.delete(token);
      deps.forget(issue.id);
      const back = await linear.getTodoIssue(issue.id);
      if (back !== null && isTodo(back)) todos = [...todos.filter((todo) => todo.id !== back.id), toView(back)].sort(byNumber);
      deps.publish();
      return id;
    });
    const steward = await deps.tellSteward(commentId, `Todo reopened ${undo.identifier}`, todoReopenedMessage(undo.identifier, undo.title));
    return { identifier: undo.identifier, steward };
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
      description: `Posts "Done (from the SGC page)" and the note as the owner. A ${HUMAN_LABEL} issue moves to the team's Done state; any other loses the ${TODO_LABEL} label and keeps its state. The steward thread gets a message.`,
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
        const told = {
          sent: "Told the steward.",
          failed: "Could not tell the steward. Retry it on the SGC questions page.",
          skipped: "Did not tell the steward: no steward thread is set, or it is archived or gone.",
        }[result.steward];
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : `Marked ${result.identifier} done: ${change}.\n${told}` };
      },
    }),
  };

  return { poll, claim, list: () => ({ todos, todoError }), rpc, commands };
}
