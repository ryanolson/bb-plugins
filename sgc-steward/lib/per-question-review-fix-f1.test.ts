import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHeader, answeredBlocks, composeAnswer, parseQuestionBlock } from "./questions.ts";
import { TWO_QUESTIONS } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "Answer fix F1: the question-number prefix turns a typed answer's quote into inline text" };

test("answer fix review F1: a typed answer keeps its quote context across a decoded line break", pending, () => {
  const block = parseQuestionBlock({ id: "q1", body: TWO_QUESTIONS, createdAt: "2026-01-06T10:00:00Z", author: "user", parentId: null }, "checkin")!;
  const text = `An example only:&#10;${answerHeader(block, false, 2)}`;
  const intended = [{ blockId: block.commentId, revision: block.revision, question: 1 }];
  // Uses the existing rewrite model: every line of an actual quote keeps its prefix.
  const edited = (body: string) => body.split("\n").flatMap((line) => {
    const quoted = line.startsWith("> ");
    return (quoted ? line.slice(2) : line).replaceAll("&#10;", "\n").split("\n").map((piece) => quoted ? `> ${piece}` : piece);
  }).join("\n");
  const picked = composeAnswer([block], [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text }] }]);
  assert.deepEqual(answeredBlocks(edited(picked)), intended, "a picked option's note is a real quote and remains safe");

  const typed = composeAnswer([block], [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: null, text }] }]);
  assert.deepEqual(answeredBlocks(typed), intended, "the local self-check passes");
  assert.deepEqual(answeredBlocks(edited(typed)), intended,
    "prefixing Q1 before the quote must not expose an unquoted Q2 header after decoding");
});
