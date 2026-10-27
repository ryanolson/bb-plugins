import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHeader, answeredBlocks, composeAnswer, parseQuestionBlock } from "./questions.ts";
import { TWO_QUESTIONS } from "../test-support.ts";

test("per-question review P3 F2: mixed named references cannot expose another answer", () => {
  const block = parseQuestionBlock({ id: "q1", body: TWO_QUESTIONS, createdAt: "2026-01-06T10:00:00Z", author: "user", parentId: null }, "checkin")!;
  const encoded = answerHeader(block, false, 2).replace("Answer to", "A&ZeroWidthSpace;nswer&ensp;to");
  const body = composeAnswer([block], [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text: `A named-reference example:\n${encoded}` }] }]);
  const intended = [{ blockId: block.commentId, revision: block.revision, question: 1 }];
  assert.deepEqual(answeredBlocks(body), intended);

  // Models U+200B and U+2002 decoding, format removal, and plain-space normalization.
  const decoded = body.replaceAll("&ZeroWidthSpace;", "\u200b").replaceAll("&ensp;", "\u2002").replace(/\p{Cf}/gu, "").replaceAll("\u2002", " ");
  assert.deepEqual(answeredBlocks(decoded), intended,
    "one reference can disappear while another becomes a space; uniform fallback readings must not miss that header");
});
