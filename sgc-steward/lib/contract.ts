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
  askedAt: z.number(),
});
const deliveryViewSchema = z.object({
  id: z.string(),
  source: z.enum(["ask", "linear", "withdrawal", "todo"]),
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
  undelivered: z.array(deliveryViewSchema),
  unposted: z.array(recordViewSchema),
  todos: z.array(todoViewSchema),
  /** Why the last read of the todos failed; the todos are then from the read before. */
  todoError: z.string().nullable(),
});
export type Panel = z.infer<typeof panelSchema>;
export type AskView = z.infer<typeof askViewSchema>;
export type DeliveryView = z.infer<typeof deliveryViewSchema>;
export type RecordView = z.infer<typeof recordViewSchema>;
export type TodoView = z.infer<typeof todoViewSchema>;

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
  /** Mark a todo done: comment as the owner, then move it to Done or remove the todo label, and tell the steward. */
  "todos.done": {
    input: z.object({ issue: z.string().min(1), note: z.string().max(TODO_NOTE_CHARS) }),
    output: z.object({
      identifier: z.string(),
      commentId: z.string(),
      change: z.enum(["state", "label"]),
      steward: z.enum(["sent", "failed", "skipped"]),
      /** Hand it to todos.reopen to undo this Done, while the plugin stays loaded. */
      undo: z.string(),
    }),
  },
  /** Undo a Done from this page: comment as the owner, put the state or the label back, and tell the steward. */
  "todos.reopen": {
    input: z.object({ undo: z.string().min(1) }),
    output: z.object({ identifier: z.string(), steward: z.enum(["sent", "failed", "skipped"]) }),
  },
  /** Hand out the questions no window has notified about yet, once each. */
  "notifications.claim": { input: z.null(), output: z.object({ notifications: z.array(notificationSchema) }) },
});
