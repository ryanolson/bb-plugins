import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { answerHeader, answeredBlocks } from "./questions.ts";
import { setup, TWO_QUESTIONS } from "../test-support.ts";

test("per-question review P2 F1: a decoded entity cannot turn a note into another answer", async (t) => {
  const { harness, linear, refresh } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", TWO_QUESTIONS);
  const block = (await refresh()).issues[0]!.blocks[0]!;
  const header = answerHeader(block, false, 2).replace(/^A/, "&#65;");
  const create = linear.createComment.bind(linear);
  linear.createComment = async (args) => {
    assert.deepEqual(answeredBlocks(args.body), [{ blockId: block.commentId, revision: block.revision, question: 1 }],
      "the local self-check sees only the intended question");
    // Models numeric entity decoding, not a captured upstream round trip.
    return create({ ...args, body: args.body.replaceAll("&#65;", "A") });
  };

  await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text: `This is an encoded example, not an answer to Q2:\n\n${header}` }] }],
  });
  const after = await harness.behavior.callRpc("questions.refresh", null) as Panel;
  assert.deepEqual(after.issues.flatMap((open) => open.blocks.flatMap((left) => left.format === "parsed" ? left.questions.map((question) => question.number) : [])), [2],
    "a character reference decoded after composition must not close the unanswered Q2");
});
