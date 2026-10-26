// SGC Steward: the steward agent's Linear questions, answered from bb.
//
// A background service polls Linear for check-in and needs-decision issues,
// keeps the open question blocks in memory for the panel and the CLI, and
// records each block in SQLite so the app can notify about it exactly once.
// Answers go back as one unsigned comment per issue. Every read and write of
// Linear runs under one lock, so a poll can never resurrect a block that an
// answer just closed, and two answers to one issue cannot both post.
import { posix } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHECKIN_LABEL, createLinearClient, DECISION_LABEL, keyProblem, LinearError, redact, type LinearClient, type LinearIssue } from "./lib/linear.ts";
import { answerCommentId, commentRole, composeAnswer, composeTextAnswer, openBlocks, type BlockAnswer, type BlockRef, type IssueKind, type LinearComment, type QuestionBlock } from "./lib/questions.ts";

/** Realtime channel: the questions changed; `newBlocks` > 0 means notify. */
const CHANNEL = "questions";
const MAX_ANSWER_BYTES = 64 * 1024;
/** Re-read every issue's comments at least this often, cache or not. */
const FULL_REFRESH_MS = 60 * 60 * 1000;
const LABEL_ATTEMPTS = 3;
const KEY_HINT = "Pipe the key in: <command that prints the key> | bb sgc key --api-key-stdin";

const optionSchema = z.object({ letter: z.string(), text: z.string(), recommended: z.boolean() });
const questionSchema = z.object({ number: z.number().int(), text: z.string(), options: z.array(optionSchema) });
const blockBase = {
  commentId: z.string(),
  revision: z.string(),
  createdAt: z.string(),
  agent: z.string(),
  threadId: z.string().nullable(),
  date: z.string().nullable(),
  body: z.string(),
};
const blockSchema = z.discriminatedUnion("format", [
  z.object({ ...blockBase, format: z.literal("parsed"), context: z.string(), questions: z.array(questionSchema) }),
  z.object({ ...blockBase, format: z.literal("raw"), problem: z.string() }),
]);
const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  kind: z.enum(["checkin", "needs-decision"]),
  blocks: z.array(blockSchema),
});
const snapshotSchema = z.object({
  configured: z.boolean(),
  teamKey: z.string(),
  /** Last successful poll, epoch ms. */
  polledAt: z.number().nullable(),
  /** Last poll attempt, epoch ms. */
  checkedAt: z.number().nullable(),
  /** Why the last poll failed; the issues are then from the poll before. */
  error: z.string().nullable(),
  /** Issues whose comments could not be read in the last poll. */
  issueErrors: z.array(z.object({ identifier: z.string(), message: z.string() })),
  issues: z.array(issueSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type IssueView = z.infer<typeof issueSchema>;

const answerInputSchema = z.object({
  issueId: z.string().min(1),
  blocks: z
    .array(
      z.object({
        blockId: z.string().min(1),
        // The revision the panel showed; a mismatch means the block changed.
        revision: z.string().min(1).max(64),
        answers: z
          .array(
            z.object({
              number: z.number().int().min(1).max(99),
              option: z.string().regex(/^[A-Z]$/).nullable(),
              text: z.string().max(20_000),
            }),
          )
          .max(99),
        text: z.string().max(20_000).optional(),
      }),
    )
    .min(1)
    .max(20),
});
const answerResultSchema = z.object({
  identifier: z.string(),
  commentId: z.string(),
  /** Null when the issue is a check-in, which has no label to remove. */
  labelRemoved: z.boolean().nullable(),
  warning: z.string().nullable(),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

const notificationSchema = z.object({
  blockId: z.string(),
  issueIdentifier: z.string(),
  issueTitle: z.string(),
  questionCount: z.number().int(),
  preview: z.string(),
});
export type QuestionNotification = z.infer<typeof notificationSchema>;

export const rpcContract = defineRpcContract({
  /** The questions from the last poll; reads nothing from Linear. */
  "questions.list": { input: z.null(), output: snapshotSchema },
  /** Poll now, reading every issue's comments again. */
  "questions.refresh": { input: z.null(), output: snapshotSchema },
  /** Post one unsigned comment that answers every open block on an issue. */
  "questions.answer": { input: answerInputSchema, output: answerResultSchema },
  /** Hand out the blocks no window has notified about yet, once each. */
  "notifications.claim": { input: z.null(), output: z.object({ notifications: z.array(notificationSchema) }) },
});

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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueKind(issue: LinearIssue): IssueKind {
  return issue.labels.some((label) => label.name === DECISION_LABEL) ? "needs-decision" : "checkin";
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function preview(block: QuestionBlock): string {
  if (block.format === "parsed") return truncate(firstLine(block.questions[0]?.text ?? ""), 160);
  const lines = block.body.trimStart().split("\n");
  const rest = lines[0]!.replace(/^\[agent:[^\]]*\]\s*/, "");
  return truncate(firstLine([rest, ...lines.slice(1)].join("\n")), 160);
}

function sameBlocks(sent: readonly BlockRef[], open: readonly QuestionBlock[]): boolean {
  const key = (id: string, revision: string) => `${id}@${revision}`;
  const a = sent.map((ref) => key(ref.blockId, ref.revision)).sort();
  const b = open.map((block) => key(block.commentId, block.revision)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `--block <comment id>@<revision>`, as `bb sgc questions` prints it. */
function parseBlockOption(value: string): BlockRef {
  const at = value.lastIndexOf("@");
  const blockId = value.slice(0, at);
  const revision = value.slice(at + 1);
  if (at <= 0 || !/^[0-9a-f]{12}$/.test(revision)) {
    throw new PluginCliError(`--block ${value} is not <comment id>@<revision>.`, {
      code: "invalid_block",
      hint: "Copy the block from `bb sgc questions`, like q1@3fa2c9d01b7e.",
    });
  }
  return { blockId, revision };
}

function formatBlock(block: QuestionBlock): string[] {
  const asker = `${block.agent}${block.threadId === null ? "" : ` ${block.threadId}`}`;
  const ref = `block ${block.commentId}@${block.revision}`;
  if (block.format === "raw") {
    const body = truncate(block.body.trim(), 4000).split("\n").map((line) => `    | ${line}`);
    return [`  Question from ${asker} (${ref}), not in the question format (${block.problem}):`, ...body];
  }
  const lines = [`  Questions ${block.date ?? block.createdAt.slice(0, 10)} from ${asker} (${ref})`];
  if (block.context !== "") lines.push(...block.context.split("\n").map((line) => `  ${line}`));
  for (const question of block.questions) {
    const [head, ...more] = question.text.split("\n");
    lines.push(`  Q${question.number}. ${head}`, ...more.map((line) => `      ${line}`));
    for (const option of question.options) {
      const [text, ...rest] = option.text.split("\n");
      lines.push(`      ${option.letter}${option.recommended ? " (recommended)" : ""}: ${text}`, ...rest.map((line) => `        ${line}`));
    }
  }
  return lines;
}

function formatSnapshot(snapshot: Snapshot): string {
  const lines: string[] = [];
  if (snapshot.issues.length === 0) lines.push(`No open questions on ${snapshot.teamKey} issues.`);
  for (const issue of snapshot.issues) {
    lines.push(`${issue.identifier}  ${issue.title}  [${issue.kind === "checkin" ? "check-in" : "needs-decision"}]`);
    for (const block of issue.blocks) lines.push(...formatBlock(block));
    const blocks = issue.blocks.map((block) => `--block ${block.commentId}@${block.revision}`).join(" ");
    lines.push(`  Answer: bb sgc answer ${issue.identifier} ${blocks} --text-file <file>`, "");
  }
  for (const failed of snapshot.issueErrors) lines.push(`Could not read ${failed.identifier}: ${failed.message}`);
  return lines.join("\n").trimEnd();
}

export function createSgcStewardPlugin(options: SgcStewardOptions = {}) {
  const retryDelayMs = options.retryDelayMs ?? 1000;
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
    ]);

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
     * Post one unsigned comment that answers every open block on an issue.
     * Reads the issue fresh first; `expected` is the blocks and revisions the
     * caller saw, and any difference refuses, so an answer never lands on a
     * question nobody read or on an option whose text changed.
     */
    function postAnswer(issueRef: string, expected: BlockRef[], compose: (blocks: QuestionBlock[]) => string): Promise<AnswerResult> {
      // An answer never waits behind a poll: stop the running one, make the
      // queued ones skip, and poll again after.
      answerEpoch += 1;
      runningPoll?.abort();
      pollAgain = true;
      wake?.();
      return locked(async () => {
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
        const blocks = issue.labels.some((label) => label.name === CHECKIN_LABEL || label.name === DECISION_LABEL)
          ? openBlocks(kind, await linear.listComments(issue.id, undefined, issue.identifier))
          : [];
        if (blocks.length === 0) throw new AnswerRefusal("conflict", `${issue.identifier} has no open questions; they may be answered already.`);
        if (!sameBlocks(expected, blocks)) {
          throw new AnswerRefusal("conflict", `The questions on ${issue.identifier} changed since you loaded them. Refresh and answer again.`);
        }
        let body: string;
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

        const commentId = await postComment(linear, issue.id, body);
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
        for (const block of blocks) mark.run(Date.now(), block.commentId);
        publish(0);
        return { identifier: issue.identifier, commentId, labelRemoved, warning };
      });
    }

    async function claimNotifications(): Promise<QuestionNotification[]> {
      const { notify } = await settings.get();
      const rows = db
        .prepare(
          `UPDATE seen_blocks SET notified_at = ? WHERE notified_at IS NULL
           RETURNING block_id, issue_identifier, issue_title, question_count, preview, first_seen_at`,
        )
        .all(Date.now()) as Array<{
        block_id: string;
        issue_identifier: string;
        issue_title: string;
        question_count: number;
        preview: string;
        first_seen_at: number;
      }>;
      if (!notify) return [];
      return rows
        .sort((a, b) => a.first_seen_at - b.first_seen_at || a.block_id.localeCompare(b.block_id))
        .map((row) => ({
          blockId: row.block_id,
          issueIdentifier: row.issue_identifier,
          issueTitle: row.issue_title,
          questionCount: row.question_count,
          preview: row.preview,
        }));
    }

    async function refuse(error: unknown): Promise<never> {
      if (error instanceof AnswerRefusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
      const { linearApiKey } = await settings.get();
      throw new Error(redact(message(error), linearApiKey ? [linearApiKey] : []));
    }

    bb.rpc.register(rpcContract, {
      "questions.list": () => snapshot,
      "questions.refresh": async () => (await pollForCaller(true)) ?? snapshot,
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

    async function readAnswerFile(path: string, ctx: PluginCliContext, machine: string | undefined): Promise<string> {
      let absolute = path;
      if (!posix.isAbsolute(path)) {
        if (ctx.cwd === undefined) {
          throw new PluginCliError(`${path} is relative and this command has no working directory.`, {
            code: "relative_path",
            hint: "Pass an absolute path to --text-file.",
          });
        }
        absolute = posix.resolve(ctx.cwd, path);
      }
      const hostId = await invokingHost(ctx, machine);
      const file = await bb.sdk.files.read({ path: absolute, ...(hostId === undefined ? {} : { hostId }) });
      if (file.sizeBytes > MAX_ANSWER_BYTES) {
        throw new PluginCliError(`${absolute} is over ${MAX_ANSWER_BYTES} bytes.`, { code: "answer_too_large" });
      }
      return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    }

    const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
    bb.cli.register(
      defineCli({
        name: "sgc",
        summary: "Answer the steward agent's Linear questions: list them, post answers, store the Linear key",
        commands: {
          questions: cliCommand({
            summary: "List open questions on the team's check-in and needs-decision issues",
            description: "Polls Linear first, unless --cached. Exits 1 when Linear or an issue's comments could not be read; the questions shown then miss what could not be read.",
            options: { json, cached: { type: "boolean", description: "Print the last poll's questions without reading Linear" } },
            async run(input) {
              const current = input.options.cached ? snapshot : await pollForCaller(false);
              if (current === null) {
                throw new PluginCliError("Answers being posted stopped the check twice.", { code: "interrupted", hint: "Run `bb sgc questions` again." });
              }
              if (!current.configured) {
                throw new PluginCliError("The Linear API key is not set.", { code: "not_configured", hint: KEY_HINT });
              }
              // A failed read hides that issue's questions, so it is a failure.
              const failures = [
                ...(current.error === null ? [] : [`Could not read Linear: ${current.error}`]),
                ...current.issueErrors.map((failed) => `Could not read ${failed.identifier}: ${failed.message}`),
              ];
              return {
                exitCode: failures.length > 0 ? 1 : 0,
                stdout: input.options.json ? JSON.stringify(current) : formatSnapshot(current),
                ...(failures.length > 0 ? { stderr: failures.join("\n") } : {}),
              };
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
              const text = (await readAnswerFile(input.options["text-file"], ctx, input.options.machine)).trim();
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
