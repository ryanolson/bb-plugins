// The Paused tab on the server: the open issues with the `paused` label, read
// with every poll, and Resume, which puts one back on the Todo list.
//
// A Resume is kept before it writes to Linear, as a Done is (see todos.ts):
// its comment posts under its own id, then it removes the label, then it
// moves the issue to Todo, under the plugin's one lock. A repeat of a Resume
// that did not finish, from the page, the CLI, or the poll, finishes that
// same Resume with its own comment, note, and steward thread. The steward's
// message is kept in the same transaction that finishes the Resume, so it
// goes out once.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PluginCliError, cliCommand, experimental_PluginRpcRefusal, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Delivery } from "./lib/ask-store.ts";
import type { ExpiredView, PausedView, rpcContract } from "./lib/contract.ts";
import { PAUSED_LABEL, postComment, type LinearClient, type PausedIssue } from "./lib/linear.ts";
import { formatPaused, resumeComment, resumeMessage } from "./lib/paused.ts";
import { Refusal } from "./lib/refusal.ts";
import { createResumeStore, type ResumeAction } from "./lib/resume-store.ts";
import { TODO_NOTE_CHARS, checkNote } from "./lib/todos.ts";

/** How long finished Resumes are kept before they are forgotten. */
const FINISHED_MS = 24 * 60 * 60 * 1000;

export type StewardTold = "sent" | "failed" | "skipped";

export interface PausedDeps {
  db: Database.Database;
  /** How long a post can take: a Resume whose comment is still missing after this is given up. */
  postWindowMs: number;
  /** Run Linear writes ahead of any poll, under the plugin's one lock. Errors come back without the key. */
  write<T>(work: (linear: LinearClient, teamKey: string) => Promise<T>): Promise<T>;
  /** The steward thread to tell, or null when none is set or bb reports it gone. */
  steward(): Promise<string | null>;
  /** Keep a finished Resume's message to send, in the caller's transaction. Returns it to send, once; null when it was kept before. */
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
  /** The questions that expired in the last 14 days, for the CLI's list. */
  expired(): ExpiredView[];
  now(): number;
  log(text: string): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toView(issue: PausedIssue): PausedView {
  return { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, state: issue.state?.name ?? null, updatedAt: issue.updatedAt };
}

function refusal(error: unknown): never {
  if (error instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
  throw error;
}

/** Whether Linear holds the whole change: the label is off and the issue is in the Todo state. */
function landed(action: Pick<ResumeAction, "labelId" | "stateId">, issue: PausedIssue): boolean {
  return !issue.labels.some((label) => label.id === action.labelId) && issue.state?.id === action.stateId;
}

export function createPaused(deps: PausedDeps) {
  const store = createResumeStore(deps.db, deps.now);
  let paused: PausedView[] = [];
  let pausedError: string | null = null;
  /** The last message sent or waiting to send. Each send waits for the one before it; none rejects. */
  let queue: Promise<StewardTold> = Promise.resolve("skipped");

  function send(row: Delivery): Promise<StewardTold> {
    queue = queue.then(() => deps.send(row)).catch(() => "failed" as const);
    return queue;
  }

  /** Finish a Resume: one transaction marks it finished and keeps its message for the thread named when it began. */
  function finish(action: ResumeAction): { told: Promise<StewardTold> } {
    const kept = deps.db.transaction(() =>
      store.finish(action.id) && action.recipient !== null
        ? deps.keep({ ref: action.id, threadId: action.recipient, label: `Resume of ${action.identifier}`, message: action.message })
        : null,
    )();
    deps.forget(action.issueId);
    return { told: kept === null ? Promise.resolve<StewardTold>("skipped") : send(kept) };
  }

  /**
   * Carry a Resume through, under the lock: its comment under its own id,
   * then the label off, then the state to Todo, each unless Linear holds it
   * already. A write whose reply was lost may have landed, so after a failure
   * only a fresh read decides. Throws, leaving the Resume unfinished, when
   * Linear lacks a write.
   */
  async function carry(linear: LinearClient, action: ResumeAction, issue: PausedIssue): Promise<{ told: Promise<StewardTold> }> {
    try {
      await postComment(linear, action.issueId, action.body, action.id);
    } catch (error) {
      throw new Error(`Could not post the comment on ${action.identifier}: ${message(error)} Press Resume again to finish it.`);
    }
    const fail = (error: unknown) =>
      new Error(`The comment is posted on ${action.identifier}, but Linear did not take the change: ${message(error)} Press Resume again to finish it.`);
    let current = issue;
    if (current.labels.some((label) => label.id === action.labelId)) {
      try {
        await linear.removeLabel({ issueId: action.issueId, labelId: action.labelId });
      } catch (error) {
        const now = await linear.getPausedIssue(action.issueId).catch(() => null);
        if (now === null || now.labels.some((label) => label.id === action.labelId)) throw fail(error);
        current = now;
      }
    }
    if (current.state?.id !== action.stateId) {
      try {
        await linear.setState({ issueId: action.issueId, stateId: action.stateId });
      } catch (error) {
        const now = await linear.getPausedIssue(action.issueId).catch(() => null);
        if (now === null || now.state?.id !== action.stateId) throw fail(error);
      }
    }
    return finish(action);
  }

  /**
   * Finish what a lost reply or a restart left: a Resume whose comment and
   * changes Linear all hold. This writes nothing to Linear. One still short
   * of either waits for the owner's retry, unless it can never finish: its
   * issue is gone, or its comment is still missing after the post window.
   */
  async function settle(linear: LinearClient, signal: AbortSignal): Promise<void> {
    for (const action of store.unfinished()) {
      let issue: PausedIssue | null;
      let posted = false;
      try {
        issue = await linear.getPausedIssue(action.issueId, signal);
        if (issue !== null) posted = (await linear.listComments(issue.id, signal, issue.identifier)).some((comment) => comment.id === action.id);
      } catch {
        if (signal.aborted) return;
        continue;
      }
      if (issue !== null && posted && landed(action, issue)) {
        finish(action);
        continue;
      }
      const why = issue === null ? "its issue is gone" : !posted && deps.now() - action.attemptedAt >= deps.postWindowMs ? "its comment never reached Linear" : null;
      if (why === null) continue;
      store.abandon(action.id);
      deps.log(`gave up the Resume of ${action.identifier}: ${why}`);
    }
    store.prune(FINISHED_MS);
  }

  /**
   * Read the paused issues, inside the poll, under its lock and signal, after
   * settling what earlier Resumes left. A failed read keeps the list from the
   * read before and records why; it does not fail the poll of the questions.
   * Null when the poll was stopped; else whether the list changed.
   */
  async function poll(linear: LinearClient, teamKey: string, signal: AbortSignal): Promise<{ changed: boolean } | null> {
    await settle(linear, signal);
    if (signal.aborted) return null;
    const before = JSON.stringify([paused, pausedError]);
    try {
      const listed = await linear.listPausedIssues(teamKey, signal);
      if (signal.aborted) return null;
      paused = listed.map(toView);
      pausedError = null;
    } catch (error) {
      if (signal.aborted) return null;
      pausedError = message(error);
    }
    return { changed: JSON.stringify([paused, pausedError]) !== before };
  }

  /**
   * Resume a paused issue: one comment from the owner, the paused label off,
   * and the issue in the team's Todo state. A Resume that did not finish is
   * finished first, with its own comment, note, and steward thread, so a
   * retry never posts a second comment or tells a second thread.
   */
  async function resume(issueRef: string, noteText: string) {
    let note: string | null;
    try {
      note = checkNote(noteText);
    } catch (error) {
      throw new Refusal("invalid", message(error));
    }
    const steward = await deps.steward();
    const { action, told, resumed } = await deps.write(async (linear, teamKey) => {
      const issue = await linear.getPausedIssue(issueRef);
      if (issue === null) throw new Refusal("not_found", `Linear has no issue ${issueRef}.`);
      if (issue.teamKey !== teamKey) throw new Refusal("invalid", `${issue.identifier} is not in team ${teamKey}.`);
      let action = store.pending(issue.id);
      const resumed = action !== null;
      if (action !== null) {
        store.attempt(action.id);
      } else {
        const label = issue.labels.find((candidate) => candidate.name === PAUSED_LABEL);
        if (label === undefined) throw new Refusal("conflict", `${issue.identifier} is not paused: it has no ${PAUSED_LABEL} label.`);
        const todo = await linear.todoStateId(teamKey);
        if (todo === null) throw new Refusal("conflict", `Team ${teamKey} has no Todo state to move ${issue.identifier} to.`);
        const begun: Omit<ResumeAction, "attemptedAt"> = {
          id: randomUUID(),
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          body: resumeComment(note),
          note,
          labelId: label.id,
          stateId: todo,
          recipient: steward,
          message: resumeMessage(issue.identifier, issue.title, note),
        };
        store.begin(begun);
        action = { ...begun, attemptedAt: deps.now() };
      }
      const { told } = await carry(linear, action, issue);
      paused = paused.filter((row) => row.id !== issue.id);
      deps.publish();
      return { action, told, resumed };
    });
    return { identifier: action.identifier, commentId: action.id, steward: await told, resumed };
  }

  const rpc = {
    "paused.resume": ({ issue, note }) => resume(issue, note).catch(refusal),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "paused.resume">;

  const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
  const commands = {
    paused: cliCommand({
      summary: "List paused work: open issues with the paused label, and questions that expired with no answer",
      description: `Lists the team's open issues with the ${PAUSED_LABEL} label, newest change first, and the questions that expired in the last 14 days. Polls Linear first, unless --cached. Exits 1 when Linear is not set up or the paused issues could not be read. Resume one with \`bb sgc resume <issue>\`.`,
      options: { json, cached: { type: "boolean", description: "Print the last poll's lists without reading Linear" } },
      async run(input) {
        if (!input.options.cached) await deps.refresh();
        const failures = [
          ...(deps.configured() ? [] : ["The Linear API key is not set, so the paused issues are not read."]),
          ...(pausedError === null ? [] : [`Could not read the paused issues: ${pausedError}`]),
        ];
        const expired = deps.expired();
        return {
          exitCode: failures.length > 0 ? 1 : 0,
          stdout: input.options.json ? JSON.stringify({ paused, pausedError, expired }) : formatPaused(paused, expired, null),
          ...(failures.length > 0 ? { stderr: failures.join("\n") } : {}),
        };
      },
    }),
    resume: cliCommand({
      summary: "Resume a paused issue: comment on it, remove the paused label, and move it to Todo",
      description: `Posts "Resumed (from the SGC page)" and the note as the owner, removes the ${PAUSED_LABEL} label, moves the issue to the team's Todo state, and tells the steward thread. The work restarts from the branch named in the pause comment. When an earlier Resume of the issue did not finish, this finishes it, with that Resume's own comment, note, and steward thread.`,
      positionals: [{ name: "issue", description: "Issue identifier, like TEAM-12", required: true }],
      options: { note: { type: "string", description: `A note for the comment and the steward, at most ${TODO_NOTE_CHARS} characters` }, json },
      async run(input) {
        let result: Awaited<ReturnType<typeof resume>>;
        try {
          result = await resume(input.positionals.issue, input.options.note ?? "");
        } catch (error) {
          if (error instanceof Refusal) throw new PluginCliError(error.message, { code: error.code });
          throw new PluginCliError(message(error), { code: "linear_error" });
        }
        const lead = result.resumed ? `Finished the earlier Resume of ${result.identifier}, with its own note` : `Resumed ${result.identifier}`;
        const told = {
          sent: "Told the steward.",
          failed: "Could not tell the steward. Retry it on the SGC questions page.",
          skipped: "Did not tell the steward: no steward thread is set, or it is archived or gone.",
        }[result.steward];
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : `${lead}: removed the ${PAUSED_LABEL} label and moved it to Todo.\n${told}` };
      },
    }),
  };

  return {
    poll,
    /** Resolves once every message queued so far was sent, or failed. */
    sent: async () => void (await queue),
    list: () => ({ paused, pausedError }),
    rpc,
    commands,
  };
}
