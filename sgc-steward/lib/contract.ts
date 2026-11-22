// The RPC contract between the server and the page, and the shapes the page
// shows. The page imports it as types only, so zod stays out of its bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TODO_NOTE_CHARS } from "./todos.ts";

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
  /** The issue's labels, a grouped one as `group/name`; its questions carry them. */
  labels: z.array(z.string()),
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

const askViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  question: z.string(),
  options: z.array(optionSchema),
  issue: z.string().nullable(),
  /** Names to sort and filter by, as the asker spelled them. */
  labels: z.array(z.string()),
  askedAt: z.number(),
});
/** A question that expired with no answer. */
const expiredViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  question: z.string(),
  issue: z.string().nullable(),
  labels: z.array(z.string()),
  askedAt: z.number(),
  expiredAt: z.number(),
});
/** An open issue with the paused label. */
const pausedViewSchema = z.object({
  /** The issue's UUID. */
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  /** The issue's state name, such as Backlog. */
  state: z.string().nullable(),
  /** ISO time of its last change. */
  updatedAt: z.string(),
});
const deliveryViewSchema = z.object({
  id: z.string(),
  source: z.enum(["ask", "linear", "withdrawal", "expiry", "resume", "todo"]),
  ref: z.string(),
  threadId: z.string(),
  label: z.string(),
  state: z.enum(["pending", "delivered", "failed"]),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.number(),
});
const recordViewSchema = z.object({
  askId: z.string(),
  issue: z.string(),
  state: z.enum(["pending", "posted", "failed"]),
  error: z.string().nullable(),
  attempts: z.number().int(),
});
const todoViewSchema = z.object({
  /** The issue's UUID. */
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  /** A human issue: Done moves it to the Done state. Otherwise Done removes the todo label. */
  human: z.boolean(),
  /** The task lines of the description, in order. */
  steps: z.array(z.object({ text: z.string(), done: z.boolean() })),
});
/** What the page shows: the last Linear poll, the open bb questions, the owner's todos, and the answers that did not go out. */
const panelSchema = snapshotSchema.extend({
  asks: z.array(askViewSchema),
  /** Questions that expired in the last 14 days, newest first. */
  expired: z.array(expiredViewSchema),
  undelivered: z.array(deliveryViewSchema),
  unposted: z.array(recordViewSchema),
  todos: z.array(todoViewSchema),
  /** Why the last read of the todos failed; the todos are then from the read before. */
  todoError: z.string().nullable(),
  /** Open issues with the paused label, newest change first. */
  paused: z.array(pausedViewSchema),
  /** Why the last read of the paused issues failed; the list is then from the read before. */
  pausedError: z.string().nullable(),
});
export type Panel = z.infer<typeof panelSchema>;
export type AskView = z.infer<typeof askViewSchema>;
export type ExpiredView = z.infer<typeof expiredViewSchema>;
export type DeliveryView = z.infer<typeof deliveryViewSchema>;
export type RecordView = z.infer<typeof recordViewSchema>;
export type TodoView = z.infer<typeof todoViewSchema>;
export type PausedView = z.infer<typeof pausedViewSchema>;

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
        // The choice picked on a raw block's card: it has no options of its own.
        option: z.string().regex(/^[A-Z]$/).nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});
const notifiedSchema = z.object({ threadId: z.string(), delivered: z.boolean(), error: z.string().nullable() });
const answerResultSchema = z.object({
  identifier: z.string(),
  commentId: z.string(),
  /** Null when the issue is a check-in, which has no label to remove. */
  labelRemoved: z.boolean().nullable(),
  warning: z.string().nullable(),
  /** The threads that signed the answered blocks, and whether the answer reached them. */
  notified: z.array(notifiedSchema),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

const notificationSchema = z.object({
  /** The Linear block's comment id, the bb question id, or the todo issue's UUID. */
  id: z.string(),
  source: z.enum(["linear", "ask", "todo"]),
  /** The issue identifier, or the asking thread's title. */
  label: z.string(),
  questionCount: z.number().int(),
  preview: z.string(),
});
export type QuestionNotification = z.infer<typeof notificationSchema>;

const hostCountsSchema = z.object({
  running: z.number().int(),
  idle: z.number().int(),
  waiting: z.number().int(),
  oldestWaitSince: z.number().nullable(),
  oldestWaitMs: z.number().nullable(),
});
/** The Hosts view, as lib/hosts.ts builds it; the handler's return type checks the two agree. */
const hostsViewSchema = z.object({
  checkedAt: z.number(),
  globalLimit: z.number().int().nullable(),
  globalAtLimit: z.boolean(),
  running: z.number().int(),
  limitError: z.string().nullable(),
  hosts: z.array(
    hostCountsSchema.extend({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      limit: z.number().int().nullable(),
      limitSource: z.enum(["override", "automatic"]).nullable(),
      automaticLimit: z.number().int().nullable(),
      atLimit: z.boolean(),
    }),
  ),
  unplaced: hostCountsSchema,
});

const threadStateSchema = z.enum(["working", "waiting", "idle-active", "parked", "done", "orphan", "stuck", "protected"]);
const decisionSchema = z.enum(["archive", "compact", "let-cool", "flag", "keep", "none"]);
/** The thread snapshot, as lib/threads-view.ts types it; the handler's return type checks the two agree. */
const threadsViewSchema = z.object({
  checkedAt: z.number(),
  mode: z.enum(["observe", "act"]),
  linearError: z.string().nullable(),
  threads: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: threadStateSchema,
      stateReason: z.string(),
      issue: z.object({ identifier: z.string(), url: z.string(), stateName: z.string() }).nullable(),
      provider: z.string(),
      model: z.string().nullable(),
      hostId: z.string().nullable(),
      hostName: z.string().nullable(),
      environmentId: z.string().nullable(),
      usedTokens: z.number().nullable(),
      contextWindow: z.number().nullable(),
      lastActivityAt: z.number(),
      expiresAt: z.number(),
      expiresSource: z.enum(["offer", "provider-table", "override"]),
      expiresIn: z.string(),
      inWindow: z.boolean(),
      decision: decisionSchema,
      reason: z.string(),
      parentThreadId: z.string().nullable().optional(),
    }),
  ),
});
const phaseSchema = z.enum(["plan", "impl", "review", "other"]);
const archiveViewSchema = z.object({
  total: z.number().int(),
  recordedSince: z.number().nullable(),
  rows: z.array(
    z.object({
      record: z.object({
        threadId: z.string(),
        title: z.string(),
        parentThreadId: z.string().nullable(),
        provider: z.string().nullable(),
        model: z.string().nullable(),
        startedAt: z.number().nullable(),
        startedFrom: z.enum(["first-turn", "created", "unknown"]),
        archivedAt: z.number(),
        source: z.enum(["lifecycle", "page", "outside"]),
        state: z.string().nullable(),
        reason: z.string(),
        issue: z.object({ identifier: z.string(), url: z.string().nullable(), stateName: z.string().nullable() }).nullable(),
        usedTokens: z.number().nullable(),
        archiveCount: z.number().int(),
      }),
      why: z.string(),
      parent: z
        .discriminatedUnion("status", [
          z.object({ threadId: z.string(), status: z.literal("archived"), title: z.string() }),
          z.object({ threadId: z.string(), status: z.literal("open"), title: z.string() }),
          z.object({ threadId: z.string(), status: z.literal("missing") }),
        ])
        .nullable(),
      children: z.array(
        z.object({ threadId: z.string(), title: z.string(), name: z.string(), phase: phaseSchema, fate: z.string(), usedTokens: z.number().nullable() }),
      ),
      summary: z.string(),
      tokens: z.string(),
      phaseTokens: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
const decisionRowSchema = z.object({
  id: z.number(),
  at: z.number(),
  threadId: z.string(),
  threadTitle: z.string(),
  decision: decisionSchema,
  state: threadStateSchema,
  reason: z.string(),
  result: z.enum(["observed", "done", "failed", "refused"]),
  error: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()),
});

export const rpcContract = defineRpcContract({
  /** The questions from the last poll and the bb questions; reads nothing from Linear. */
  "questions.list": { input: z.null(), output: panelSchema },
  /** Poll now, reading every issue's comments again. */
  "questions.refresh": { input: z.null(), output: panelSchema },
  /** Post one unsigned comment that answers every open block on an issue. */
  "questions.answer": { input: answerInputSchema, output: answerResultSchema },
  /** Answer a bb question: send it to the asking thread, and record it on its issue. */
  "asks.answer": {
    input: z.object({ id: z.string().min(1), option: z.string().regex(/^[A-Z]$/).nullable(), text: z.string().max(20_000) }),
    output: z.object({
      id: z.string(),
      delivered: z.boolean(),
      deliveryError: z.string().nullable(),
      record: z.enum(["none", "posted", "failed"]),
      recordError: z.string().nullable(),
    }),
  },
  /** Send an undelivered answer again. Ask the owner first: a send that seemed to fail may have landed. */
  "deliveries.retry": { input: z.object({ id: z.string().min(1) }), output: z.object({ delivered: z.boolean(), error: z.string().nullable() }) },
  /** Post a record that did not post. */
  "records.retry": { input: z.object({ askId: z.string().min(1) }), output: z.object({ posted: z.boolean(), error: z.string().nullable() }) },
  /** Stop listing a send that did not go out, and never send it. */
  "deliveries.dismiss": { input: z.object({ id: z.string().min(1) }), output: z.object({ dismissed: z.boolean() }) },
  /** Stop listing a record that did not post, and never post it. */
  "records.dismiss": { input: z.object({ askId: z.string().min(1) }), output: z.object({ dismissed: z.boolean() }) },
  /** Mark a todo done: comment as the owner, then move it to Done or remove the todo label, and tell the steward. */
  "todos.done": {
    input: z.object({ issue: z.string().min(1), note: z.string().max(TODO_NOTE_CHARS) }),
    output: z.object({
      identifier: z.string(),
      commentId: z.string(),
      change: z.enum(["state", "label"]),
      steward: z.enum(["sent", "failed", "skipped"]),
      /** Hand it to todos.reopen to undo this Done, while the plugin stays loaded and no newer Done of the issue finishes. */
      undo: z.string(),
      /** This finished an earlier Done of the issue that had not finished, with that Done's own comment and note. */
      resumed: z.boolean(),
    }),
  },
  /** Undo a Done from this page: comment as the owner, put the state or the label back, and tell the steward. */
  "todos.reopen": {
    input: z.object({ undo: z.string().min(1) }),
    output: z.object({ identifier: z.string(), steward: z.enum(["sent", "failed", "skipped"]) }),
  },
  /** Resume a paused issue: comment as the owner, remove the paused label, move it to Todo, and tell the steward. */
  "paused.resume": {
    input: z.object({ issue: z.string().min(1), note: z.string().max(TODO_NOTE_CHARS) }),
    output: z.object({
      identifier: z.string(),
      commentId: z.string(),
      steward: z.enum(["sent", "failed", "skipped"]),
      /** This finished an earlier Resume of the issue that had not finished, with that Resume's own comment and note. */
      resumed: z.boolean(),
    }),
  },
  /** Per host: running and idle threads, turns waiting on the limit, and the limit. Reads bb only; never changes a limit. */
  "hosts.list": { input: z.null(), output: hostsViewSchema },
  /** The thread lifecycle snapshot and the decision log. Reads bb when asked to, or when there is no snapshot yet. */
  "threads.list": {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({ view: threadsViewSchema.nullable(), log: z.array(decisionRowSchema) }),
  },
  /** Keep a thread (protected for 24 hours), compact it now, or archive it now. Refused with the reason when it is not safe. */
  "threads.act": {
    input: z.object({ threadId: z.string().min(1), action: z.enum(["keep", "compact", "archive"]) }),
    output: z.object({ message: z.string() }),
  },
  /** The archived threads the plugin recorded, newest first, with their roll-ups. Reads only the plugin's database. */
  "archive.list": { input: z.null(), output: archiveViewSchema },
  /** Hand out the questions no window has notified about yet, once each. */
  "notifications.claim": { input: z.null(), output: z.object({ notifications: z.array(notificationSchema) }) },
});
