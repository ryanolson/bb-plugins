import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHeader, answeredBlocks, composeAnswer, parseQuestionBlock } from "./questions.ts";
import { TWO_QUESTIONS } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "Answer fix F2: an unquoted ASCII heading can expose a header in Setext form" };

test("answer fix review F2: changing heading syntax cannot turn a note into an answer", pending, () => {
  const block = parseQuestionBlock({ id: "q1", body: TWO_QUESTIONS, createdAt: "2026-01-06T10:00:00Z", author: "user", parentId: null }, "checkin")!;
  const heading = `# ${answerHeader(block, false, 2)}`;
  assert.match(heading, /^[\x20-\x7e]+$/);
  assert.doesNotMatch(heading, /[&\\*_`~<]| {2}/);
  const body = composeAnswer([block], [{ blockId: block.commentId, revision: block.revision, answers: [{ number: 1, option: "A", text: heading }] }]);
  const intended = [{ blockId: block.commentId, revision: block.revision, question: 1 }];
  assert.deepEqual(answeredBlocks(body), intended);

  // Models an ATX heading serialized as an equivalent Setext heading, not a captured upstream round trip.
  const edited = body.split("\n").flatMap((line) => line.startsWith("# ") ? [line.slice(2), "==="] : [line]).join("\n");
  assert.deepEqual(answeredBlocks(edited), intended,
    "a heading-style rewrite must not turn an unquoted ASCII note into a Q2 answer");
});
