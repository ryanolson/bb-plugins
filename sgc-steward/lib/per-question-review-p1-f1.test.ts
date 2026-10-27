import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { answerHeader } from "./questions.ts";
import { setup, TWO_QUESTIONS } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "Per-question F1: a header quoted in an answer closes an unanswered question" };

test("per-question review F1: a quoted header in a note cannot answer another question", pending, async (t) => {
  const { harness, linear, refresh, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", TWO_QUESTIONS);
  const shown = await refresh();
  const block = shown.issues[0]!.blocks[0]!;
  assert.equal(block.format, "parsed");
  assert.deepEqual(block.questions.map((question) => question.number), [1, 2]);
  const note = ["This is a format example, not an answer to the other question:", "", "```text", answerHeader(block, false, 2), "```"].join("\n");

  await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text: note }] }],
  });
  assert.equal(issue.comments.length, 2, "one answer is posted");
  assert.equal(sends.length, 1, "the asking thread hears one answer");
  const after = await harness.behavior.callRpc("questions.refresh", null) as Panel;
  assert.deepEqual(after.issues.flatMap((open) => open.blocks.flatMap((left) => left.format === "parsed" ? left.questions.map((question) => question.number) : [])), [2],
    "only the selected Q1 is answered; a fenced example in the note is content, not another answer header");
});
