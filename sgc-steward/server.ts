// SGC Steward: questions for the owner, answered from bb without blocking
// the agents that ask them.
//
// Two kinds of question: blocks a steward agent posts on Linear issues, which
// a background service polls, and questions agents ask with `bb sgc ask`,
// kept in SQLite. Answers to blocks go back as one unsigned comment per issue;
// every answer is also sent to the asking thread as a queued message. Every
// read and write of Linear runs under one lock, so a poll can never resurrect
// a block that an answer just closed, and two answers to one issue cannot
// both post.
import { posix } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHECKIN_LABEL, createLinearClient, DECISION_LABEL, keyProblem, LinearError, redact, type LinearClient, type LinearIssue } from "./lib/linear.ts";
import {
  answerCommentId,
  commentRole,
  composeAnswer,
  composeTextAnswer,
  openBlocks,
  parseQuestionBlock,
  type BlockAnswer,
  type BlockRef,
  type IssueKind,
  type LinearComment,
  type QuestionBlock,
} from "./lib/questions.ts";
import {
  ASK_LIMITS,
  DELIVERY_PREFIX,
  askDelivery,
  askOptions,
  askRecord,
  blockDelivery,
  checkIssueRef,
  checkQuestion,
  isThreadId,
  type AskAnswer,
} from "./lib/asks.ts";
import { ASK_MIGRATIONS, createAskId, createAskStore, type AskRow, type Delivery, type RecordRow, type Undelivered } from "./lib/ask-store.ts";
import {
  rpcContract,
  type AnswerResult,
  type AskView,
  type DeliveryView,
  type IssueView,
  type Panel,
  type QuestionNotification,
  type RecordView,
  type Snapshot,
} from "./lib/contract.ts";
import { firstLine, formatPanel, parseBlockOption, preview, truncate } from "./lib/format.ts";

/** Realtime channel: the questions changed; `newBlocks` > 0 means notify. */
const CHANNEL = "questions";
const MAX_ANSWER_BYTES = 64 * 1024;
/** Re-read every issue's comments at least this often, cache or not. */
const FULL_REFRESH_MS = 60 * 60 * 1000;
const LABEL_ATTEMPTS = 3;
const KEY_HINT = "Pipe the key in: <command that prints the key> | bb sgc key --api-key-stdin";

type RefusalCode = "conflict" | "invalid" | "not_found";

/** A refusal shared by the panel and the CLI: nothing was posted. */
class AnswerRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SgcStewardOptions {
  /** Stand-in for Linear in tests. */
  createClient?: (apiKey: string) => LinearClient;
  /** Pause between label removal attempts. */
  retryDelayMs?: number;
  /**
   * How long an answer's post can take. A delivery held for an answer that
   * is still not on Linear after this long is dropped: the post failed.
   */
  postWindowMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueKind(issue: LinearIssue): IssueKind {
  return issue.labels.some((label) => label.name === DECISION_LABEL) ? "needs-decision" : "checkin";
}

function sameBlocks(sent: readonly BlockRef[], open: readonly QuestionBlock[]): boolean {
  const key = (id: string, revision: string) => `${id}@${revision}`;
  const a = sent.map((ref) => key(ref.blockId, ref.revision)).sort();
  const b = open.map((block) => key(block.commentId, block.revision)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function askView(row: AskRow): AskView {
  return { id: row.id, threadId: row.threadId, threadTitle: row.threadTitle, question: row.question, options: row.options, issue: row.issue, askedAt: row.askedAt };
}

function deliveryView(row: Undelivered): DeliveryView {
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    threadId: row.threadId,
    label: row.label,
    state: row.state,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
  };
}

function recordView(row: RecordRow): RecordView {
  return { askId: row.askId, issue: row.issue, state: row.state, error: row.error, attempts: row.attempts };
}

export function createSgcStewardPlugin(options: SgcStewardOptions = {}) {
  const retryDelayMs = options.retryDelayMs ?? 1000;
  // Two tries of 30 seconds each, the checks after them, and a wide margin.
  const postWindowMs = options.postWindowMs ?? 10 * 60 * 1000;
  const makeClient = options.createClient ?? ((apiKey: string) => createLinearClient({ apiKey }));

  return async function sgcSteward(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define({
      linearApiKey: {
        type: "string",
        label: "Linear API key",
        description: "A personal Linear API key that can read the team's issues and post comments. Kept as a secret on the bb server.",
        secret: true,
        // A key that is not a valid header value would be quoted back by the
        // runtime's header error, so it is refused on save.
        experimental_schema: z.string().regex(/^[\x21-\x7e]+$/, "Paste only the key: no spaces, line breaks, or other control characters."),
      },
      teamKey: {
        type: "string",
        label: "Linear team key",
        description: "The team whose check-in and needs-decision issues hold the questions.",
        default: "STRGT",
        experimental_schema: z.string().regex(/^[A-Z0-9]{1,16}$/, "Use the team key, like ENG"),
      },
      pollMinutes: {
        type: "number",
        label: "Poll interval (minutes)",
        description: "How often to read Linear for new questions.",
        default: 5,
        experimental_schema: z.number().int().min(1).max(1440),
      },
      notify: {
        type: "boolean",
        label: "Notify on new questions",
        description: "Show a notification in bb, once per question block, when new questions arrive.",
        default: true,
      },
    });

    const initial = await settings.get();
    if (!initial.linearApiKey) {
      bb.status.needsConfiguration(`Set the Linear API key. ${KEY_HINT}`);
    }

    const db = bb.storage.database();
    bb.storage.migrate(db, [
      `CREATE TABLE IF NOT EXISTS seen_blocks (
        block_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        question_count INTEGER NOT NULL,
        preview TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        notified_at INTEGER
      )`,
      ...ASK_MIGRATIONS,
    ]);
    const asks = createAskStore(db);

    let snapshot: Snapshot = {
      configured: Boolean(initial.linearApiKey),
      teamKey: initial.teamKey,
      polledAt: null,
      checkedAt: null,
      error: null,
      issueErrors: [],
      issues: [],
    };
    const commentCache = new Map<string, { updatedAt: string; comments: LinearComment[] }>();
    let lastFullRefreshAt = 0;
    let client: { key: string; client: LinearClient } | null = null;

    function clientFor(apiKey: string): LinearClient {
      if (client === null || client.key !== apiKey) client = { key: apiKey, client: makeClient(apiKey.trim()) };
      return client.client;
    }

    // One lock for every Linear read or write that touches local state.
    let tail: Promise<unknown> = Promise.resolve();
    function locked<T>(work: () => Promise<T>): Promise<T> {
      const run = tail.then(work, work);
      tail = run.catch(() => undefined);
      return run;
    }

    function publish(newBlocks: number): void {
      bb.realtime.publish(CHANNEL, { newBlocks });
    }

    /** Record open blocks; returns how many are new and still to be notified. */
    function reconcileSeen(issues: IssueView[], unreadIssueIds: Set<string>, notify: boolean): number {
      const now = Date.now();
      const open = new Map<string, { issue: IssueView; block: QuestionBlock }>();
      for (const issue of issues) for (const block of issue.blocks) open.set(block.commentId, { issue, block });
      const rows = db.prepare("SELECT block_id, issue_id FROM seen_blocks").all() as Array<{ block_id: string; issue_id: string }>;
      const known = new Set(rows.map((row) => row.block_id));
      const insert = db.prepare(
        `INSERT INTO seen_blocks (block_id, issue_id, issue_identifier, issue_title, question_count, preview, first_seen_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const remove = db.prepare("DELETE FROM seen_blocks WHERE block_id = ?");
      let fresh = 0;
      db.transaction(() => {
        for (const [blockId, { issue, block }] of open) {
          if (known.has(blockId)) continue;
          const count = block.format === "parsed" ? block.questions.length : 1;
          insert.run(blockId, issue.id, issue.identifier, issue.title, count, preview(block), now, notify ? null : now);
          if (notify) fresh += 1;
        }
        // A block that closed is forgotten, unless its issue could not be read.
        for (const row of rows) {
          if (!open.has(row.block_id) && !unreadIssueIds.has(row.issue_id)) remove.run(row.block_id);
        }
      })();
      return fresh;
    }

    /** The poll in progress, so an answer can stop it instead of waiting. */
    let runningPoll: AbortController | null = null;
    /** Set when the poller should poll again at once: settings changed, or an answer stopped a poll. */
    let pollAgain = false;
    let wake: (() => void) | null = null;

    async function pollNow(force: boolean, outer?: AbortSignal): Promise<Snapshot | null> {
      const controller = new AbortController();
      runningPoll = controller;
      const signal = outer === undefined ? controller.signal : AbortSignal.any([outer, controller.signal]);
      try {
        return await pollOnce(force, signal);
      } finally {
        if (runningPoll === controller) runningPoll = null;
      }
    }

    /** One poll. A stopped poll commits nothing, records no error, and returns null. */
    async function pollOnce(force: boolean, signal: AbortSignal): Promise<Snapshot | null> {
      const { linearApiKey, teamKey, notify } = await settings.get();
      const checkedAt = Date.now();
      const before = JSON.stringify([snapshot.configured, snapshot.error, snapshot.issueErrors, snapshot.issues]);
      if (!linearApiKey) {
        snapshot = { configured: false, teamKey, polledAt: null, checkedAt, error: null, issueErrors: [], issues: [] };
        if (JSON.stringify([snapshot.configured, snapshot.error, snapshot.issueErrors, snapshot.issues]) !== before) publish(0);
        return snapshot;
      }
      const linear = clientFor(linearApiKey);
      const fullRefresh = force || checkedAt - lastFullRefreshAt >= FULL_REFRESH_MS;
      try {
        await settleHeld(linear, signal, linearApiKey);
        if (signal.aborted) return null;
        const listed = await linear.listQuestionIssues(teamKey, signal);
        if (signal.aborted) return null;
        const issues: IssueView[] = [];
        const issueErrors: Snapshot["issueErrors"] = [];
        const unread = new Set<string>();
        for (const issue of listed) {
          try {
            const cached = commentCache.get(issue.id);
            const comments =
              !fullRefresh && cached?.updatedAt === issue.updatedAt ? cached.comments : await linear.listComments(issue.id, signal, issue.identifier);
            commentCache.set(issue.id, { updatedAt: issue.updatedAt, comments });
            const kind = issueKind(issue);
            const blocks = openBlocks(kind, comments);
            if (blocks.length > 0) {
              issues.push({ id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, kind, blocks });
            }
          } catch (error) {
            // A bad key or the rate limit fails the whole poll; anything else
            // only this issue.
            if (signal.aborted || (error instanceof LinearError && (error.kind === "auth" || error.kind === "rate-limit"))) throw error;
            unread.add(issue.id);
            issueErrors.push({ identifier: issue.identifier, message: redact(message(error), [linearApiKey]) });
          }
        }
        if (signal.aborted) return null;
        for (const id of commentCache.keys()) if (!listed.some((issue) => issue.id === id)) commentCache.delete(id);
        if (fullRefresh) lastFullRefreshAt = checkedAt;
        const oldest = (issue: IssueView) => Math.min(...issue.blocks.map((block) => Date.parse(block.createdAt)));
        issues.sort((a, b) => oldest(a) - oldest(b));
        snapshot = { configured: true, teamKey, polledAt: checkedAt, checkedAt, error: null, issueErrors, issues };
        const fresh = reconcileSeen(issues, unread, notify);
        const after = JSON.stringify([snapshot.configured, snapshot.error, snapshot.issueErrors, snapshot.issues]);
        if (fresh > 0 || after !== before) publish(fresh);
      } catch (error) {
        if (signal.aborted) return null;
        const reason = redact(message(error), [linearApiKey]);
        bb.log.warn(`poll failed: ${reason}`);
        snapshot = { ...snapshot, configured: true, teamKey, checkedAt, error: reason };
        if (JSON.stringify([snapshot.configured, snapshot.error, snapshot.issueErrors, snapshot.issues]) !== before) publish(0);
      }
      return snapshot;
    }

    /** Bumped by every answer. A poll queued before an answer skips itself, so the answer goes first. */
    let answerEpoch = 0;
    const poll = (force: boolean, signal?: AbortSignal) => {
      const epoch = answerEpoch;
      return locked(() => (answerEpoch === epoch ? pollNow(force, signal) : Promise.resolve(null)));
    };
    /** Poll for a caller who waits for the result: once more if an answer stopped the first poll. */
    const pollForCaller = async (force: boolean) => (await poll(force)) ?? (await poll(force));

    /** A Linear write never waits behind a poll: stop the running one, make the queued ones skip, and poll again after. */
    function writeFirst(): void {
      answerEpoch += 1;
      runningPoll?.abort();
      pollAgain = true;
      wake?.();
    }

    function panel(): Panel {
      return {
        ...snapshot,
        asks: asks.listOpen().map(askView),
        undelivered: asks.undelivered().map(deliveryView),
        unposted: asks.unposted().map(recordView),
      };
    }

    /** Sends in flight, so two retries at once cannot send one answer twice. */
    const sending = new Set<string>();

    /**
     * Send a kept delivery to its thread as a queued message, the way
     * `bb thread tell --mode queue` does. Never throws: a failed send is kept,
     * marked, for the owner to retry.
     */
    async function deliver(id: string): Promise<Delivery | null> {
      const row = asks.getDelivery(id);
      if (row === null || row.state === "held" || row.state === "delivered" || sending.has(id)) return row;
      sending.add(id);
      try {
        await bb.sdk.threads.send({ threadId: row.threadId, mode: "queue-if-active", input: [{ type: "text", text: row.message, mentions: [] }] });
        asks.markDelivery(id, { ok: true });
      } catch (error) {
        const reason = truncate(message(error), 300);
        asks.markDelivery(id, { ok: false, error: reason });
        bb.log.warn(`could not deliver the answer for ${row.label} to ${row.threadId}: ${reason}`);
      } finally {
        sending.delete(id);
      }
      publish(0);
      return asks.getDelivery(id);
    }

    function notified(row: Delivery | null, threadId: string): { threadId: string; delivered: boolean; error: string | null } {
      const delivered = row?.state === "delivered";
      return { threadId, delivered, error: delivered ? null : (row?.error ?? null) };
    }

    /** The bb threads that signed the blocks, once each. */
    function signers(blocks: readonly QuestionBlock[]): string[] {
      return [...new Set(blocks.flatMap((block) => (block.threadId !== null && isThreadId(block.threadId) ? [block.threadId] : [])))];
    }

    /** Keep the deliveries of an answer to Linear blocks, held until the answer is known to be on Linear. */
    function holdDeliveries(issue: LinearIssue, commentId: string, body: string, blocks: readonly QuestionBlock[]): void {
      const text = blockDelivery(issue.identifier, commentId, body);
      asks.hold({ ref: commentId, issueId: issue.id, label: issue.identifier, message: text }, signers(blocks));
    }

    /**
     * Send the deliveries this caller released, and report every thread that
     * signed the answered blocks. A delivery released earlier is not sent
     * again: only the owner's retry does that.
     */
    async function sendReleased(released: readonly Delivery[], commentId: string, threads: readonly string[]) {
      const results = [];
      for (const threadId of threads) {
        const row = released.find((candidate) => candidate.threadId === threadId);
        results.push(notified(row === undefined ? asks.deliveryFor("linear", commentId, threadId) : await deliver(row.id), threadId));
      }
      return results;
    }

    /**
     * Settle the deliveries a restart left held. Held means the answer's post
     * was in flight, so it may or may not be on Linear. Once it is there, the
     * deliveries are sent, once. Once it is still missing after the post
     * window, they are dropped. This runs under the lock, but a plugin
     * instance from before a reload may still be posting, so a missing answer
     * inside the window is left for the next poll.
     */
    async function settleHeld(linear: LinearClient, signal: AbortSignal, apiKey: string): Promise<void> {
      for (const held of asks.held()) {
        let comments: LinearComment[];
        try {
          comments = await linear.listComments(held.issueId, signal, held.label);
        } catch (error) {
          if (signal.aborted) return;
          bb.log.warn(`could not check whether the answer ${held.ref} on ${held.label} posted: ${redact(message(error), [apiKey])}`);
          continue;
        }
        if (comments.some((comment) => comment.id === held.ref)) {
          for (const row of asks.release(held.ref)) await deliver(row.id);
        } else if (Date.now() - held.heldAt >= postWindowMs) {
          asks.drop(held.ref);
          bb.log.warn(`dropped the deliveries of answer ${held.ref} on ${held.label}: it never posted`);
        }
      }
    }

    /** Post the Linear record of an answered bb question, under the same id rules as answers. */
    function postRecord(askId: string): Promise<RecordRow | null> {
      writeFirst();
      return locked(async () => {
        const record = asks.record(askId);
        if (record === null || record.state === "posted") return record;
        const { linearApiKey, teamKey } = await settings.get();
        let outcome: { ok: true; commentId: string } | { ok: false; error: string };
        if (!linearApiKey) {
          outcome = { ok: false, error: `The Linear API key is not set. ${KEY_HINT}` };
        } else {
          try {
            const linear = clientFor(linearApiKey);
            const issue = await linear.getIssue(record.issue);
            if (issue === null) outcome = { ok: false, error: `Linear has no issue ${record.issue}.` };
            else if (issue.teamKey !== teamKey) outcome = { ok: false, error: `${issue.identifier} is not in team ${teamKey}.` };
            else {
              outcome = { ok: true, commentId: await postComment(linear, issue.id, record.body) };
              commentCache.delete(issue.id);
            }
          } catch (error) {
            outcome = { ok: false, error: redact(message(error), [linearApiKey]) };
          }
        }
        asks.markRecord(askId, outcome);
        if (!outcome.ok) bb.log.warn(`could not record ${askId} on ${record.issue}: ${outcome.error}`);
        publish(0);
        return asks.record(askId);
      });
    }

    /** A failure where Linear may have done the write before the reply was lost. */
    function unclear(error: unknown): boolean {
      return error instanceof LinearError && (error.kind === "network" || error.kind === "http" || error.kind === "timeout");
    }

    /**
     * Post an answer under the id derived from it. A comment with that id is
     * this same answer, from an earlier try or submission, so finding one
     * after a failure counts as success. Only an unclear failure is tried a
     * second time, with the same id.
     */
    async function postComment(linear: LinearClient, issueId: string, body: string): Promise<string> {
      const commentId = answerCommentId(issueId, body);
      const landed = () =>
        linear.listComments(issueId).then(
          (comments) => comments.some((comment) => comment.id === commentId),
          () => false,
        );
      try {
        return await linear.createComment({ issueId, body, commentId });
      } catch (error) {
        if (await landed()) return commentId;
        if (!unclear(error)) throw error;
      }
      try {
        return await linear.createComment({ issueId, body, commentId });
      } catch (error) {
        if (await landed()) return commentId;
        throw error;
      }
    }

    /** Null on success, else why the label is still there. */
    async function removeLabel(linear: LinearClient, issueId: string, labelId: string): Promise<string | null> {
      let last: unknown = null;
      for (let attempt = 1; attempt <= LABEL_ATTEMPTS; attempt += 1) {
        try {
          await linear.removeLabel({ issueId, labelId });
          return null;
        } catch (error) {
          last = error;
          const current = await linear.getIssue(issueId).catch(() => null);
          if (current !== null && !current.labels.some((label) => label.id === labelId)) return null;
          if (attempt < LABEL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
      return message(last);
    }

    /**
     * The answer an earlier try already posted: the comment with the id this
     * same answer derives, when it is on the issue. Its reply was lost, so
     * the answer is finished instead of refused.
     */
    function postedBefore(
      issue: LinearIssue,
      comments: readonly LinearComment[],
      expected: readonly BlockRef[],
      compose: (blocks: QuestionBlock[]) => string,
    ): { commentId: string; body: string; blocks: QuestionBlock[] } | null {
      const byId = new Map(comments.map((comment) => [comment.id, comment]));
      const blocks: QuestionBlock[] = [];
      for (const ref of expected) {
        const comment = byId.get(ref.blockId);
        // The id and revision pin the block, so any signed comment may be read as one.
        const block = comment === undefined ? null : parseQuestionBlock(comment, "needs-decision");
        if (block === null || block.revision !== ref.revision) return null;
        blocks.push(block);
      }
      blocks.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.commentId.localeCompare(b.commentId));
      let body: string;
      try {
        body = compose(blocks);
      } catch {
        return null;
      }
      const commentId = answerCommentId(issue.id, body);
      return byId.has(commentId) ? { commentId, body, blocks } : null;
    }

    /**
     * Post one unsigned comment that answers every open block on an issue,
     * then send it to the threads that signed the blocks. Reads the issue
     * fresh first; `expected` is the blocks and revisions the caller saw, and
     * any difference refuses, so an answer never lands on a question nobody
     * read or on an option whose text changed.
     */
    async function postAnswer(issueRef: string, expected: BlockRef[], compose: (blocks: QuestionBlock[]) => string): Promise<AnswerResult> {
      writeFirst();
      const posted = await locked(async () => {
        const { linearApiKey, teamKey } = await settings.get();
        if (!linearApiKey) throw new AnswerRefusal("invalid", `The Linear API key is not set. ${KEY_HINT}`);
        const linear = clientFor(linearApiKey);
        const issue = await linear.getIssue(issueRef);
        if (issue === null) throw new AnswerRefusal("not_found", `Linear has no issue ${issueRef}.`);
        if (issue.teamKey !== teamKey) throw new AnswerRefusal("invalid", `${issue.identifier} is not in team ${teamKey}.`);
        if (issue.state !== null && (issue.state.type === "completed" || issue.state.type === "canceled")) {
          throw new AnswerRefusal("conflict", `${issue.identifier} is ${issue.state.type}, so it takes no answer.`);
        }
        const kind = issueKind(issue);
        const comments = await linear.listComments(issue.id, undefined, issue.identifier);
        const blocks = issue.labels.some((label) => label.name === CHECKIN_LABEL || label.name === DECISION_LABEL) ? openBlocks(kind, comments) : [];
        const earlier = sameBlocks(expected, blocks) ? null : postedBefore(issue, comments, expected, compose);

        let commentId: string;
        let body: string;
        let answered: QuestionBlock[];
        if (earlier !== null) {
          ({ commentId, body, blocks: answered } = earlier);
          holdDeliveries(issue, commentId, body, answered);
        } else {
          if (blocks.length === 0) throw new AnswerRefusal("conflict", `${issue.identifier} has no open questions; they may be answered already.`);
          if (!sameBlocks(expected, blocks)) {
            throw new AnswerRefusal("conflict", `The questions on ${issue.identifier} changed since you loaded them. Refresh and answer again.`);
          }
          try {
            body = compose(blocks);
          } catch (error) {
            throw new AnswerRefusal("invalid", message(error));
          }
          if (body.trim() === "") throw new AnswerRefusal("invalid", "The answer is empty.");
          if (Buffer.byteLength(body) > MAX_ANSWER_BYTES) throw new AnswerRefusal("invalid", `The answer is over ${MAX_ANSWER_BYTES} bytes.`);
          if (commentRole({ body, author: "user" }) !== "answer") {
            throw new AnswerRefusal("invalid", "The answer starts with [agent:, so Linear would show it as an agent's comment, not an answer.");
          }
          commentId = answerCommentId(issue.id, body);
          answered = blocks;
          // Kept before the post, so a restart while it is in flight cannot
          // lose them. A failed post leaves them held for settleHeld.
          holdDeliveries(issue, commentId, body, answered);
          await postComment(linear, issue.id, body);
        }
        // The answer is on Linear. The deliveries this call releases are its
        // to send; ones released before, it leaves to the owner.
        const released = asks.release(commentId);

        let labelRemoved: boolean | null = null;
        let warning: string | null = null;
        const label = kind === "needs-decision" ? issue.labels.find((candidate) => candidate.name === DECISION_LABEL) : undefined;
        if (label !== undefined) {
          // Another agent can post a newer question while this answer is
          // written. The label stays until nothing on the issue is open.
          let stillOpen: QuestionBlock[] | null = null;
          try {
            stillOpen = openBlocks("needs-decision", await linear.listComments(issue.id, undefined, issue.identifier));
          } catch (error) {
            bb.log.warn(`could not re-read ${issue.identifier} after answering: ${redact(message(error), [linearApiKey])}`);
          }
          if (stillOpen === null || stillOpen.length > 0) {
            labelRemoved = false;
            warning =
              stillOpen === null
                ? `The answer is posted. ${issue.identifier} could not be read again, so the needs-decision label stays. Remove it in Linear if no question is open.`
                : `The answer is posted. A newer question is open on ${issue.identifier}, so the needs-decision label stays.`;
          } else {
            const failure = await removeLabel(linear, issue.id, label.id);
            labelRemoved = failure === null;
            if (failure !== null) {
              warning = `The answer is posted, but the needs-decision label is still on ${issue.identifier} (${redact(failure, [linearApiKey])}). Remove it in Linear.`;
              bb.log.warn(warning);
            }
          }
        }

        // The answer closed these blocks: drop them now rather than at the
        // next poll, and never notify about them.
        commentCache.delete(issue.id);
        snapshot = { ...snapshot, issues: snapshot.issues.filter((open) => open.id !== issue.id) };
        const mark = db.prepare("UPDATE seen_blocks SET notified_at = COALESCE(notified_at, ?) WHERE block_id = ?");
        for (const block of answered) mark.run(Date.now(), block.commentId);
        publish(0);
        return { result: { identifier: issue.identifier, commentId, labelRemoved, warning }, released, threads: signers(answered) };
      });
      return { ...posted.result, notified: await sendReleased(posted.released, posted.result.commentId, posted.threads) };
    }

    async function claimNotifications(): Promise<QuestionNotification[]> {
      const { notify } = await settings.get();
      const blocks = db
        .prepare(
          `UPDATE seen_blocks SET notified_at = ? WHERE notified_at IS NULL
           RETURNING block_id, issue_identifier, question_count, preview, first_seen_at`,
        )
        .all(Date.now()) as Array<{ block_id: string; issue_identifier: string; question_count: number; preview: string; first_seen_at: number }>;
      const asked = asks.claim();
      if (!notify) return [];
      const notices = [
        ...blocks.map((row) => ({
          at: row.first_seen_at,
          notice: { id: row.block_id, source: "linear" as const, label: row.issue_identifier, questionCount: row.question_count, preview: row.preview },
        })),
        ...asked.map((row) => ({
          at: row.askedAt,
          notice: { id: row.id, source: "ask" as const, label: row.threadTitle || row.threadId, questionCount: 1, preview: truncate(firstLine(row.question), 160) },
        })),
      ];
      return notices.sort((a, b) => a.at - b.at || a.notice.id.localeCompare(b.notice.id)).map((entry) => entry.notice);
    }

    async function refuse(error: unknown): Promise<never> {
      if (error instanceof AnswerRefusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
      const { linearApiKey } = await settings.get();
      throw new Error(redact(message(error), linearApiKey ? [linearApiKey] : []));
    }

    bb.rpc.register(rpcContract, {
      "questions.list": () => panel(),
      "questions.refresh": async () => {
        await pollForCaller(true);
        return panel();
      },
      "questions.answer": async ({ issueId, blocks }) => {
        const answers: BlockAnswer[] = blocks.map((block) => ({
          blockId: block.blockId,
          revision: block.revision,
          answers: block.answers,
          ...(block.text === undefined ? {} : { text: block.text }),
        }));
        try {
          return await postAnswer(
            issueId,
            blocks.map((block) => ({ blockId: block.blockId, revision: block.revision })),
            (open) => composeAnswer(open, answers),
          );
        } catch (error) {
          return await refuse(error);
        }
      },
      "asks.answer": async ({ id, option, text }) => {
        const row = asks.get(id);
        if (row === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No bb question ${id}.` });
        if (row.state !== "open") throw new experimental_PluginRpcRefusal({ code: "conflict", message: `${id} is ${row.state}.` });
        const answer: AskAnswer = { option, text };
        let delivery: string;
        let record: { issue: string; body: string } | null;
        try {
          delivery = askDelivery(row, answer);
          record = row.issue === null ? null : { issue: row.issue, body: askRecord(row, answer) };
        } catch (error) {
          throw new experimental_PluginRpcRefusal({ code: "invalid", message: message(error) });
        }
        const saved = asks.answer(id, answer, { message: delivery, label: id }, record);
        if (saved !== "answered") {
          throw new experimental_PluginRpcRefusal({ code: saved === "not_found" ? "not_found" : "conflict", message: `${id} is no longer open.` });
        }
        publish(0);
        const kept = asks.deliveryFor("ask", id, row.threadId);
        const sent = notified(kept === null ? null : await deliver(kept.id), row.threadId);
        const posted = record === null ? null : await postRecord(id);
        return {
          id,
          delivered: sent.delivered,
          deliveryError: sent.error,
          record: posted === null ? ("none" as const) : posted.state === "posted" ? ("posted" as const) : ("failed" as const),
          recordError: posted === null || posted.state === "posted" ? null : posted.error,
        };
      },
      "deliveries.retry": async ({ id }) => {
        const row = await deliver(id);
        if (row === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No delivery ${id}.` });
        return { delivered: row.state === "delivered", error: row.state === "delivered" ? null : row.error };
      },
      "records.retry": async ({ askId }) => {
        const row = await postRecord(askId);
        if (row === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No record for ${askId}.` });
        return { posted: row.state === "posted", error: row.state === "posted" ? null : row.error };
      },
      "notifications.claim": async () => ({ notifications: await claimNotifications() }),
    });

    /** The machine the CLI was called from: the thread's, `--machine`, or the server's. */
    async function invokingHost(ctx: PluginCliContext, machine: string | undefined): Promise<string | undefined> {
      if (machine !== undefined) {
        const hosts = await bb.sdk.hosts.list();
        const matches = hosts.filter((host) => host.id === machine || host.name === machine);
        if (matches.length === 1) return matches[0]!.id;
        throw new PluginCliError(
          matches.length === 0 ? `No machine is named ${machine}.` : `${matches.length} machines are named ${machine}; use an id.`,
          { code: "unknown_machine", hint: "Run `bb machine list` for names and ids." },
        );
      }
      if (ctx.threadId === undefined) return undefined;
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId === null) return undefined;
      return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
    }

    async function readHostFile(path: string, ctx: PluginCliContext, machine: string | undefined, flag: string): Promise<string> {
      let absolute = path;
      if (!posix.isAbsolute(path)) {
        if (ctx.cwd === undefined) {
          throw new PluginCliError(`${path} is relative and this command has no working directory.`, {
            code: "relative_path",
            hint: `Pass an absolute path to ${flag}.`,
          });
        }
        absolute = posix.resolve(ctx.cwd, path);
      }
      const hostId = await invokingHost(ctx, machine);
      const file = await bb.sdk.files.read({ path: absolute, ...(hostId === undefined ? {} : { hostId }) });
      if (file.sizeBytes > MAX_ANSWER_BYTES) {
        throw new PluginCliError(`${absolute} is over ${MAX_ANSWER_BYTES} bytes.`, { code: "file_too_large" });
      }
      return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    }

    const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
    bb.cli.register(
      defineCli({
        name: "sgc",
        summary: "Ask the owner questions without waiting, list them, answer Linear questions, store the Linear key",
        commands: {
          questions: cliCommand({
            summary: "List open questions: Linear question blocks, bb questions, and answers that did not go out",
            description: "Polls Linear first, unless --cached. Exits 1 when Linear is not set up or could not be read, or an issue's comments could not be read; the questions shown then miss what could not be read.",
            options: { json, cached: { type: "boolean", description: "Print the last poll's questions without reading Linear" } },
            async run(input) {
              const polled = input.options.cached ? snapshot : await pollForCaller(false);
              if (polled === null) {
                throw new PluginCliError("Answers being posted stopped the check twice.", { code: "interrupted", hint: "Run `bb sgc questions` again." });
              }
              const current = panel();
              // A failed read hides that issue's questions, so it is a failure.
              const failures = [
                ...(current.configured ? [] : [`The Linear API key is not set, so Linear questions are not listed. ${KEY_HINT}`]),
                ...(current.error === null ? [] : [`Could not read Linear: ${current.error}`]),
                ...current.issueErrors.map((failed) => `Could not read ${failed.identifier}: ${failed.message}`),
              ];
              return {
                exitCode: failures.length > 0 ? 1 : 0,
                stdout: input.options.json ? JSON.stringify(current) : formatPanel(current),
                ...(failures.length > 0 ? { stderr: failures.join("\n") } : {}),
              };
            },
          }),
          ask: cliCommand({
            summary: "Ask the owner a question without waiting: store it and print its id",
            description: `Returns at once; keep working. The answer arrives in the asking thread as a queued message that starts with "${DELIVERY_PREFIX} Answer to <id>". The same open question from the same thread returns its existing id. A thread can have ${ASK_LIMITS.openPerThread} open questions, and all threads ${ASK_LIMITS.openTotal}.`,
            options: {
              question: { type: "string", description: `The question, at most ${ASK_LIMITS.questionChars} characters` },
              "question-file": { type: "string", description: "File with the question, on the calling thread's machine" },
              option: {
                type: "string",
                repeatable: true,
                description: `An answer to offer, at most ${ASK_LIMITS.options}, ${ASK_LIMITS.optionChars} characters each; they get letters A, B, and so on`,
              },
              recommend: { type: "string", description: "The letter of the recommended option, or none; default A when there are options" },
              issue: { type: "string", description: "A Linear issue, like TEAM-12, that gets a comment recording the question and its answer" },
              thread: { type: "string", description: "The asking thread, which gets the answer; default the calling thread" },
              machine: { type: "string", description: "Machine that holds --question-file, when not called from a thread" },
              json,
            },
            constraints: [{ kind: "exactly-one", options: ["question", "question-file"] }],
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (threadId === undefined) {
                throw new PluginCliError("No asking thread.", { code: "no_thread", hint: "Run it from a bb thread, or pass --thread <id>." });
              }
              if (!isThreadId(threadId)) throw new PluginCliError(`${threadId} is not a bb thread id, like thr_abc123.`, { code: "invalid_thread" });
              const raw =
                input.options["question-file"] === undefined
                  ? (input.options.question ?? "")
                  : await readHostFile(input.options["question-file"], ctx, input.options.machine, "--question-file");
              let question: string;
              let options: ReturnType<typeof askOptions>;
              let issue: string | null;
              try {
                question = checkQuestion(raw);
                const texts = input.options.option ?? [];
                const recommend = input.options.recommend === undefined ? (texts.length > 0 ? "A" : null) : input.options.recommend === "none" ? null : input.options.recommend;
                options = askOptions(texts, recommend);
                issue = input.options.issue === undefined ? null : checkIssueRef(input.options.issue);
              } catch (error) {
                throw new PluginCliError(message(error), { code: "invalid" });
              }
              let threadTitle: string;
              try {
                const thread = await bb.sdk.threads.get({ threadId });
                threadTitle = thread.title ?? thread.titleFallback ?? "";
              } catch {
                throw new PluginCliError(`No bb thread ${threadId}.`, { code: "unknown_thread", hint: "The asking thread gets the answer, so it must exist." });
              }
              const reply = (id: string, existing: boolean) => {
                const where = threadId === ctx.threadId ? "this thread" : `thread ${threadId}`;
                return {
                  exitCode: 0,
                  stdout: input.options.json
                    ? JSON.stringify({ id, existing })
                    : `${existing ? "Already asked" : "Asked"} ${id}. Keep working: the answer arrives in ${where} as a message that starts with "${DELIVERY_PREFIX} Answer to ${id}".`,
                };
              };
              // Read everything first: no other ask may run between the checks and the insert.
              const { notify } = await settings.get();
              const admitted = asks.admit({ id: createAskId(), threadId, threadTitle, question, options, issue, askedAt: Date.now() }, !notify);
              if (admitted.kind === "full") {
                const thread = admitted.scope === "thread";
                throw new PluginCliError(thread ? `${threadId} already has ${admitted.open} open questions.` : `${admitted.open} questions are already open.`, {
                  code: "too_many",
                  hint: thread ? "Wait for answers, or withdraw one with `bb sgc withdraw <id>`." : "Wait for the owner to answer some.",
                });
              }
              if (admitted.kind === "asked") publish(notify ? 1 : 0);
              return reply(admitted.id, admitted.kind === "existing");
            },
          }),
          withdraw: cliCommand({
            summary: "Withdraw a question the calling thread asked",
            positionals: [{ name: "id", description: "Question id, like bbq_k3x9mz2p4q", required: true }],
            options: { thread: { type: "string", description: "The asking thread, when not called from a thread" }, json },
            async run(input, ctx) {
              // A thread withdraws only its own questions; --thread is for the owner's terminal.
              const threadId = ctx.threadId ?? input.options.thread;
              if (threadId === undefined) {
                throw new PluginCliError("No asking thread.", { code: "no_thread", hint: "Run it from the thread that asked, or pass --thread <id>." });
              }
              if (input.options.thread !== undefined && input.options.thread !== threadId) {
                throw new PluginCliError(`${threadId} cannot withdraw for ${input.options.thread}.`, { code: "forbidden", hint: "A thread withdraws only its own questions." });
              }
              const id = input.positionals.id;
              const outcome = asks.withdraw(id, threadId);
              if (outcome === "not_found") throw new PluginCliError(`No bb question ${id}.`, { code: "not_found" });
              if (outcome === "not_yours") throw new PluginCliError(`${id} was asked by another thread.`, { code: "forbidden" });
              if (outcome === "not_open") throw new PluginCliError(`${id} is not open.`, { code: "conflict" });
              publish(0);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ id, withdrawn: true }) : `Withdrew ${id}.` };
            },
          }),
          answer: cliCommand({
            summary: "Post a file as the unsigned answer to an issue's open questions",
            description:
              "Posts one comment: a header line that names each block, then the file's text as written. Name every open block of the issue with --block, as `bb sgc questions` prints it; the answer is refused when the open blocks or their revisions differ. Number the answers to match: `Q1. A`. On a needs-decision issue the label is removed too.",
            positionals: [{ name: "issue", description: "Issue identifier, like TEAM-12", required: true }],
            options: {
              block: {
                type: "string",
                required: true,
                repeatable: true,
                placeholder: "id@revision",
                description: "A block to answer, as `bb sgc questions` prints it: <comment id>@<revision>; repeat it for every open block",
              },
              "text-file": {
                type: "string",
                required: true,
                aliases: ["file"],
                description: `File with the answer, on the calling thread's machine; at most ${MAX_ANSWER_BYTES} bytes`,
              },
              machine: {
                type: "string",
                description: "Machine that holds the file, by name or id, when not called from a thread",
              },
              json,
            },
            async run(input, ctx) {
              const refs = input.options.block.map(parseBlockOption);
              const text = (await readHostFile(input.options["text-file"], ctx, input.options.machine, "--text-file")).trim();
              if (commentRole({ body: text, author: "user" }) !== "answer") {
                throw new PluginCliError("The answer text starts with [agent:, an agent's signature.", {
                  code: "invalid",
                  hint: "Relay only the owner's own words, without a signature.",
                });
              }
              let result: AnswerResult;
              try {
                result = await postAnswer(input.positionals.issue, refs, (blocks) => composeTextAnswer(blocks, text));
              } catch (error) {
                if (error instanceof AnswerRefusal) throw new PluginCliError(error.message, { code: error.code });
                const { linearApiKey } = await settings.get();
                throw new PluginCliError(redact(message(error), linearApiKey ? [linearApiKey] : []), { code: "linear_error" });
              }
              const lines = [`Posted the answer to ${result.identifier} (comment ${result.commentId}).`];
              if (result.labelRemoved === true) lines.push("Removed the needs-decision label.");
              if (result.warning !== null) lines.push(result.warning);
              for (const sent of result.notified) {
                lines.push(sent.delivered ? `Sent it to ${sent.threadId}.` : `Could not send it to ${sent.threadId}: ${sent.error ?? "unknown error"}. Retry it on the SGC questions page.`);
              }
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : lines.join("\n") };
            },
          }),
          key: cliCommand({
            summary: "Store the Linear API key in the plugin's secret settings",
            description: "Pipe the key in with --api-key-stdin so it stays out of the command line and shell history. The key is never printed.",
            options: {
              "api-key": {
                type: "string",
                required: true,
                stdin: true,
                description: "The Linear API key; pass it with --api-key-stdin",
              },
            },
            async run(input) {
              const key = input.options["api-key"].trim();
              const problem = keyProblem(key);
              if (problem !== null) throw new PluginCliError(problem, { code: "invalid_key", hint: KEY_HINT });
              await settings.experimental_set({ linearApiKey: key });
              return { exitCode: 0, stdout: "Saved the Linear API key. The next poll uses it." };
            },
          }),
        },
      }),
    );

    // A settings change wakes the poller; a change during a poll makes it
    // poll again at once.
    settings.onChange(() => {
      pollAgain = true;
      client = null;
      commentCache.clear();
      wake?.();
    });

    bb.background.service("poller", {
      async start(signal) {
        while (!signal.aborted) {
          pollAgain = false;
          await poll(false, signal);
          if (pollAgain || signal.aborted) continue;
          const { pollMinutes } = await settings.get();
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              wake = null;
              resolve();
            };
            const timer = setTimeout(done, pollMinutes * 60_000);
            signal.addEventListener("abort", done, { once: true });
            wake = done;
          });
        }
      },
    });
  };
}

export default createSgcStewardPlugin();
