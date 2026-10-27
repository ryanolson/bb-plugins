import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHeader, answeredBlocks, composeAnswer, parseQuestionBlock } from "./questions.ts";
import { TWO_QUESTIONS } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "Per-question P3 F1: decoding stops before deeper character references become headers" };

test("per-question review P3 F1: deeper entity nesting remains quoted after recursive decoding", pending, () => {
  const block = parseQuestionBlock({ id: "q1", body: TWO_QUESTIONS, createdAt: "2026-01-06T10:00:00Z", author: "user", parentId: null }, "checkin")!;
  let encoded = answerHeader(block, false, 2).replace(/^A/, "&#65;");
  for (let level = 0; level < 5; level += 1) encoded = encoded.replaceAll("&", "&amp;");
  const body = composeAnswer([block], [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text: `A nested example:\n${encoded}` }] }]);
  const intended = [{ blockId: block.commentId, revision: block.revision, question: 1 }];
  assert.deepEqual(answeredBlocks(body), intended);

  // Models the recursively decoded reading claimed by the writing helper.
  let decoded = body;
  for (;;) {
    const next = decoded.replaceAll("&amp;", "&").replaceAll("&#65;", "A");
    if (next === decoded) break;
    decoded = next;
  }
  assert.deepEqual(answeredBlocks(decoded), intended,
    "a deeper encoding must not expose an unquoted Q2 header after the local self-check passes");
});
