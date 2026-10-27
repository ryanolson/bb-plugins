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
import {
  PluginCliError,
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHECKIN_LABEL, createLinearClient, DECISION_LABEL, keyProblem, LinearError, postComment, redact, type LinearClient, type LinearIssue } from "./lib/linear.ts";
import {
  answerCommentId,
  answerFor,
  answeredBlocks,
  closeAnswered,
  commentRole,
  composeAnswer,
  composeTextAnswer,
  openBlocks,
  postedBefore,
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
  checkReason,
  isThreadId,
  withdrawalFollowUps,
  type AskAnswer,
} from "./lib/asks.ts";
import { STORE_MIGRATIONS, createAskId, createAskStore, type AskRow, type Delivery, type RecordRow, type Undelivered, type Unposted } from "./lib/ask-store.ts";
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
import { readHostFile } from "./lib/host-file.ts";
import { Refusal } from "./lib/refusal.ts";
import { createTodos } from "./todos.ts";
import { SETTINGS, WITHDRAW_TOOL } from "./lib/settings.ts";
import { firstLine, formatPanel, parseBlockOption, preview, truncate, withdrawalReport, type WithdrawalResult } from "./lib/format.ts";

/** Realtime channel: the questions changed; `newBlocks` > 0 means notify. */
const CHANNEL = "questions";
const MAX_ANSWER_BYTES = 64 * 1024;
/** Re-read every issue's comments at least this often, cache or not. */
const FULL_REFRESH_MS = 60 * 60 * 1000;
const LABEL_ATTEMPTS = 3;
const KEY_HINT = "Pipe the key in: <command that prints the key> | bb sgc key --api-key-stdin";
/** bb clears a needs-configuration notice only when the plugin loads again; saving settings does not reload it. */
const RELOAD_HINT = "Then run `bb plugin reload sgc-steward` to clear this notice.";

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

function recordView(row: Unposted): RecordView {
  return { askId: row.askId, issue: row.issue, state: row.state, error: row.error, attempts: row.attempts };
}

export function createSgcStewardPlugin(options: SgcStewardOptions = {}) {
  const retryDelayMs = options.retryDelayMs ?? 1000;
  // Two tries of 30 seconds each, the checks after them, and a wide margin.
  const postWindowMs = options.postWindowMs ?? 10 * 60 * 1000;
  const makeClient = options.createClient ?? ((apiKey: string) => createLinearClient({ apiKey }));

  return async function sgcSteward(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(SETTINGS);

    const initial = await settings.get();
    if (!initial.linearApiKey) {
      bb.status.needsConfiguration(`Set the Linear API key. ${KEY_HINT}. ${RELOAD_HINT}`);
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
      ...STORE_MIGRATIONS,
    ]);
    const asks = createAskStore(db);
    const todos = createTodos({
      db,
      postWindowMs,
      write: writeLinear,
      steward: stewardFor,
      keep: (row) => asks.keep({ source: "todo", ...row }),
      send: async (row) => ((await deliver(row.id))?.state === "delivered" ? "sent" : "failed"),
      forget: (issueId) => commentCache.delete(issueId),
      publish: () => publish(0),
      refresh: async () => void (await pollForCaller(false)),
      configured: () => snapshot.configured,
      log: (text) => bb.log.warn(text),
    });

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
        const todoNews = await todos.poll(linear, teamKey, notify, signal);
        if (todoNews === null) return null;
        for (const id of commentCache.keys()) if (!listed.some((issue) => issue.id === id)) commentCache.delete(id);
        if (fullRefresh) lastFullRefreshAt = checkedAt;
        const oldest = (issue: IssueView) => Math.min(...issue.blocks.map((block) => Date.parse(block.createdAt)));
        issues.sort((a, b) => oldest(a) - oldest(b));
        snapshot = { configured: true, teamKey, polledAt: checkedAt, checkedAt, error: null, issueErrors, issues };
        const fresh = reconcileSeen(issues, unread, notify) + todoNews.fresh;
        const after = JSON.stringify([snapshot.configured, snapshot.error, snapshot.issueErrors, snapshot.issues]);
        if (fresh > 0 || todoNews.changed || after !== before) publish(fresh);
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
    /** Deliveries a poll released from held, sent once the poll has left the lock. */
    const releasedByPoll: Delivery[] = [];
    const poll = async (force: boolean, signal?: AbortSignal) => {
      const epoch = answerEpoch;
      const polled = await locked(() => (answerEpoch === epoch ? pollNow(force, signal) : Promise.resolve(null)));
      // Outside the lock, so a slow thread send never holds up an answer.
      for (const row of releasedByPoll.splice(0)) await deliver(row.id);
      await todos.sent();
      return polled;
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
        ...todos.list(),
      };
    }

    /**
     * Whether a thread is gone for good: archived, deleted, or unknown to bb
     * (HTTP 404, `thread_not_found`). Any other lookup failure says nothing
     * about the thread, so a message for it is kept, to be sent or retried.
     */
    async function threadGone(threadId: string): Promise<boolean> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return Boolean(thread.archivedAt || thread.deletedAt);
      } catch (error) {
        const failure = error as { status?: unknown; code?: unknown };
        return failure.status === 404 || failure.code === "thread_not_found";
      }
    }

    /**
     * Withdraw a question for a caller. Only the steward may withdraw another
     * thread's question, and must give a reason: the asker is then told,
     * unless bb reports it gone, and the question's issue gets a record.
     */
    async function withdrawAsk(id: string, caller: { thread: string; by: string | null; steward: boolean }, reason: string | null) {
      const refuse = (code: "not_found" | "forbidden" | "conflict" | "invalid", text: string) => ({ ok: false as const, code, message: text });
      const row = asks.get(id);
      const others = caller.steward && row !== null && row.threadId !== caller.thread ? row : null;
      if (others !== null && reason === null) return refuse("invalid", `Give a reason to withdraw ${id}, a question of ${others.threadId}.`);
      const followUps =
        others === null || reason === null
          ? { notice: null, record: null }
          : withdrawalFollowUps(others, caller.thread, reason, others.state === "open" && !(await threadGone(others.threadId)), Date.now());
      const outcome = asks.withdraw(id, { ...caller, reason, ...followUps });
      if (outcome === "not_found") return refuse("not_found", `No bb question ${id}.`);
      if (outcome === "not_yours") return refuse("forbidden", `${id} was asked by another thread.`);
      if (outcome === "not_open") return refuse("conflict", `${id} is not open.`);
      publish(0);
      if (others === null) return { ok: true as const, report: `Withdrew ${id}.` };
      const kept = asks.deliveryFor("withdrawal", id, others.threadId);
      const sent = kept === null ? null : notified(await deliver(kept.id), others.threadId);
      const posted = others.issue === null ? null : await postRecord(id);
      const result: WithdrawalResult = {
        id,
        withdrawn: true,
        notice: sent === null ? "skipped" : sent.delivered ? "sent" : "failed",
        record: posted === null ? "none" : posted.state === "posted" ? "posted" : "failed",
      };
      return { ok: true as const, report: withdrawalReport(result, others.threadId, sent?.error ?? null, others.issue, posted?.error ?? null) };
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
      if (row === null || (row.state !== "pending" && row.state !== "failed") || sending.has(id)) return row;
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
     * deliveries are released for the poll to send, once. Once it is still
     * missing after the post window, they are dropped. This runs under the
     * lock, but a plugin instance from before a reload may still be posting,
     * so a missing answer inside the window is left for the next poll.
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
          releasedByPoll.push(...asks.release(held.ref));
        } else if (Date.now() - held.heldAt >= postWindowMs) {
          asks.drop(held.ref);
          bb.log.warn(`dropped the deliveries of answer ${held.ref} on ${held.label}: it never posted`);
        }
      }
    }

    /** Linear writes for the todo list: ahead of polls, under the one lock, with the key kept out of errors. */
    function writeLinear<T>(work: (linear: LinearClient, teamKey: string) => Promise<T>): Promise<T> {
      writeFirst();
      return locked(async () => {
        const { linearApiKey, teamKey } = await settings.get();
        if (!linearApiKey) throw new Refusal("invalid", `The Linear API key is not set. ${KEY_HINT}`);
        try {
          return await work(clientFor(linearApiKey), teamKey);
        } catch (error) {
          if (error instanceof Refusal) throw error;
          throw new Error(redact(message(error), [linearApiKey]));
        }
      });
    }

    /** The steward thread to tell, or null when none is set or bb reports it gone. */
    async function stewardFor(): Promise<string | null> {
      const { stewardThread } = await settings.get();
      return stewardThread === undefined || (await threadGone(stewardThread)) ? null : stewardThread;
    }

    /** Post the Linear record of an answered bb question, under the same id rules as answers. */
    function postRecord(askId: string): Promise<RecordRow | null> {
      writeFirst();
      return locked(async () => {
        const record = asks.record(askId);
        if (record === null || record.state === "posted" || record.state === "dismissed") return record;
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
     * Post one unsigned comment that answers the named blocks, or some of
     * their questions, then send it to the threads that signed them. Reads
     * the issue fresh first; `expected` is the blocks and revisions the
     * caller saw, and each must still be open at that revision, with every
     * question the answer names, so an answer never lands on a question
     * nobody read or on an option whose text changed.
     */
    async function postAnswer(issueRef: string, expected: BlockRef[], compose: (blocks: QuestionBlock[]) => string): Promise<AnswerResult> {
      writeFirst();
      const posted = await locked(async () => {
        const { linearApiKey, teamKey } = await settings.get();
        if (!linearApiKey) throw new Refusal("invalid", `The Linear API key is not set. ${KEY_HINT}`);
        const linear = clientFor(linearApiKey);
        const issue = await linear.getIssue(issueRef);
        if (issue === null) throw new Refusal("not_found", `Linear has no issue ${issueRef}.`);
        if (issue.teamKey !== teamKey) throw new Refusal("invalid", `${issue.identifier} is not in team ${teamKey}.`);
        if (issue.state !== null && (issue.state.type === "completed" || issue.state.type === "canceled")) {
          throw new Refusal("conflict", `${issue.identifier} is ${issue.state.type}, so it takes no answer.`);
        }
        const kind = issueKind(issue);
        const comments = await linear.listComments(issue.id, undefined, issue.identifier);
        const blocks = issue.labels.some((label) => label.name === CHECKIN_LABEL || label.name === DECISION_LABEL) ? openBlocks(kind, comments) : [];
        let fresh: ReturnType<typeof answerFor>;
        try {
          fresh = answerFor(expected, blocks, comments, compose);
        } catch (error) {
          throw new Refusal("invalid", message(error));
        }
        const earlier = fresh === null ? postedBefore(issue.id, comments, expected, compose) : null;

        let commentId: string;
        let body: string;
        let answered: QuestionBlock[];
        if (earlier !== null) {
          ({ commentId, body, blocks: answered } = earlier);
          holdDeliveries(issue, commentId, body, answered);
        } else {
          if (blocks.length === 0) throw new Refusal("conflict", `${issue.identifier} has no open questions; they may be answered already.`);
          if (fresh === null) {
            throw new Refusal("conflict", `The questions on ${issue.identifier} changed or were answered since you loaded them. Refresh and answer again.`);
          }
          body = fresh.body;
          if (body.trim() === "") throw new Refusal("invalid", "The answer is empty.");
          if (Buffer.byteLength(body) > MAX_ANSWER_BYTES) throw new Refusal("invalid", `The answer is over ${MAX_ANSWER_BYTES} bytes.`);
          if (commentRole({ body, author: "user" }) !== "answer") {
            throw new Refusal("invalid", "The answer starts with [agent:, so Linear would show it as an agent's comment, not an answer.");
          }
          commentId = answerCommentId(issue.id, body);
          answered = fresh.blocks;
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
                : `The answer is posted. A question is still open on ${issue.identifier}, so the needs-decision label stays.`;
          } else {
            const failure = await removeLabel(linear, issue.id, label.id);
            labelRemoved = failure === null;
            if (failure !== null) {
              warning = `The answer is posted, but the needs-decision label is still on ${issue.identifier} (${redact(failure, [linearApiKey])}). Remove it in Linear.`;
              bb.log.warn(warning);
            }
          }
        }

        // Drop what the answer closed now rather than at the next poll, keep
        // what it left open, and never notify about the blocks it answered.
        const left = earlier !== null ? blocks : closeAnswered(blocks, answeredBlocks(body) ?? []);
        commentCache.delete(issue.id);
        snapshot = { ...snapshot, issues: snapshot.issues.flatMap((open) => (open.id !== issue.id ? [open] : left.length === 0 ? [] : [{ ...open, blocks: left }])) };
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
      const todoNotes = todos.claim();
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
        ...todoNotes.map((row) => ({ at: row.at, notice: { id: row.id, source: "todo" as const, label: row.label, questionCount: 1, preview: truncate(row.preview, 160) } })),
      ];
      return notices.sort((a, b) => a.at - b.at || a.notice.id.localeCompare(b.notice.id)).map((entry) => entry.notice);
    }

    async function refuse(error: unknown): Promise<never> {
      if (error instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
      const { linearApiKey } = await settings.get();
      throw new Error(redact(message(error), linearApiKey ? [linearApiKey] : []));
    }

    /** Tell open pages that a row the owner dismissed is gone. */
    const dismissed = (done: boolean) => (done && publish(0), { dismissed: done });

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
      "deliveries.dismiss": ({ id }) => dismissed(asks.dismissDelivery(id)),
      "records.dismiss": ({ askId }) => dismissed(asks.dismissRecord(askId)),
      "notifications.claim": async () => ({ notifications: await claimNotifications() }),
      ...todos.rpc,
    });

    // The steward's power to withdraw any question lives only here: bb hands
    // execute the thread of the agent session that made the call, which no
    // argument or environment variable can set. The CLI forwards
    // BB_THREAD_ID unverified, so it withdraws only the caller's own.
    bb.agents.registerTool({
      name: WITHDRAW_TOOL,
      description:
        "SGC Steward: withdraw an open bb question that is no longer valid, giving the reason. Only the thread named in the plugin's stewardThread setting may call it; it refuses every other thread.",
      parameters: z.object({ id: z.string().min(1), reason: z.string() }),
      async execute({ id, reason }, ctx) {
        const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
        const { stewardThread } = await settings.get();
        if (stewardThread === undefined || ctx.threadId !== stewardThread) {
          return refuse("Only the steward thread, named in the SGC Steward stewardThread setting, may use this tool. Withdraw your own question with `bb sgc withdraw <id>`.");
        }
        let checked: string;
        try {
          checked = checkReason(reason);
        } catch (error) {
          return refuse(message(error));
        }
        const done = await withdrawAsk(id, { thread: ctx.threadId, by: ctx.threadId, steward: true }, checked);
        return done.ok ? done.report : refuse(done.message);
      },
    });

    const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
    bb.cli.register(
      defineCli({
        name: "sgc",
        summary: "Ask the owner questions without waiting, list them, answer Linear questions, store the Linear key",
        commands: {
          ...todos.commands,
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
                  : await readHostFile(bb.sdk, input.options["question-file"], ctx, input.options.machine, "--question-file", MAX_ANSWER_BYTES);
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
            description: `A thread withdraws only its own questions; the CLI forwards the calling thread unverified, so it grants nothing more. The steward withdraws other threads' questions with the ${WITHDRAW_TOOL} agent tool, which bb attributes to the calling thread.`,
            positionals: [{ name: "id", description: "Question id, like bbq_k3x9mz2p4q", required: true }],
            options: {
              reason: { type: "string", description: `Why it is withdrawn, at most ${ASK_LIMITS.reasonChars} characters; stored with the question` },
              thread: { type: "string", description: "The asking thread, when not called from a thread" },
              json,
            },
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
              let reason: string | null;
              try {
                reason = input.options.reason === undefined ? null : checkReason(input.options.reason);
              } catch (error) {
                throw new PluginCliError(message(error), { code: "invalid" });
              }
              const done = await withdrawAsk(id, { thread: threadId, by: ctx.threadId ?? null, steward: false }, reason);
              if (!done.ok) throw new PluginCliError(done.message, { code: done.code });
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ id, withdrawn: true }) : done.report };
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
              const text = (await readHostFile(bb.sdk, input.options["text-file"], ctx, input.options.machine, "--text-file", MAX_ANSWER_BYTES)).trim();
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
                if (error instanceof Refusal) throw new PluginCliError(error.message, { code: error.code });
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
              const notice = initial.linearApiKey ? "" : " bb plugin list shows the plugin as needing configuration until `bb plugin reload sgc-steward`.";
              return { exitCode: 0, stdout: `Saved the Linear API key. The next poll uses it.${notice}` };
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
          // A stop that came while the settings were read fired already; the sleep below would miss it.
          if (signal.aborted) break;
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
