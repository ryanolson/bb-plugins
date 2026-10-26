import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_LIMITS,
  answerText,
  askDelivery,
  askOptions,
  askRecord,
  blockDelivery,
  checkIssueRef,
  checkQuestion,
  isThreadId,
  type Ask,
} from "./asks.ts";
import { answeredBlocks, commentRole } from "./questions.ts";

const ASK: Ask = {
  id: "bbq_test1",
  threadId: "thr_test9",
  threadTitle: "Driver: test project",
  question: "Ship the cache change today?\nIt touches `the router`.",
  options: [
    { letter: "A", text: "Yes, today.", recommended: true },
    { letter: "B", text: "No, wait for the soak.", recommended: false },
  ],
  issue: "TEAM-12",
  askedAt: Date.parse("2026-01-05T10:00:00Z"),
};

test("a question is trimmed and must say something, within the limit", () => {
  assert.equal(checkQuestion("  Ship it?\n"), "Ship it?");
  assert.throws(() => checkQuestion(" \n "), /the question is empty/);
  assert.throws(() => checkQuestion("x".repeat(ASK_LIMITS.questionChars + 1)), /over 4000 characters/);
});

test("options get letters in order, and the recommendation is the one named", () => {
  assert.deepEqual(askOptions([" Yes. ", "No."], "A"), [
    { letter: "A", text: "Yes.", recommended: true },
    { letter: "B", text: "No.", recommended: false },
  ]);
  assert.deepEqual(askOptions(["Yes.", "No."], "B").map((option) => option.recommended), [false, true]);
  assert.deepEqual(askOptions(["Yes.", "No."], null).map((option) => option.recommended), [false, false]);
  assert.deepEqual(askOptions([], null), []);
  assert.throws(() => askOptions(Array.from({ length: ASK_LIMITS.options + 1 }, (_, n) => `o${n}`), "A"), /at most 10 options/);
  assert.throws(() => askOptions(["Yes.", " "], "A"), /option B is empty/);
  assert.throws(() => askOptions(["x".repeat(ASK_LIMITS.optionChars + 1)], "A"), /option A is over 500 characters/);
  assert.throws(() => askOptions(["Yes.", "No."], "C"), /there is no option C to recommend/);
});

test("an issue is named by its identifier", () => {
  assert.equal(checkIssueRef("TEAM-12"), "TEAM-12");
  assert.throws(() => checkIssueRef("team-12"), /not an issue identifier/);
  assert.throws(() => checkIssueRef("TEAM12"), /not an issue identifier/);
});

test("a bb thread id is recognized", () => {
  assert.equal(isThreadId("thr_test9"), true);
  assert.equal(isThreadId("thr_"), false);
  assert.equal(isThreadId("session-42"), false);
});

test("the answer keeps the owner's words exactly", () => {
  assert.equal(answerText(ASK, { option: "B", text: "" }), "B: No, wait for the soak.");
  assert.equal(answerText(ASK, { option: "A", text: "  Only behind\nthe `flag`.  " }), "A: Yes, today.\nOnly behind\nthe `flag`.");
  assert.equal(answerText(ASK, { option: null, text: "Ask the router owner." }), "Ask the router owner.");
  assert.throws(() => answerText(ASK, { option: "C", text: "" }), /there is no option C/);
  assert.throws(() => answerText(ASK, { option: null, text: "  " }), /the answer is empty/);
  assert.throws(() => answerText({ ...ASK, options: [] }, { option: "A", text: "" }), /there is no option A/);
});

test("the delivered message quotes the id, the question, and the answer", () => {
  assert.equal(
    askDelivery(ASK, { option: "B", text: "Soak until Friday." }),
    [
      "[sgc-steward] Answer to bbq_test1",
      "",
      "Your question, asked 2026-01-05 10:00 UTC:",
      "Ship the cache change today?",
      "It touches `the router`.",
      "",
      "Options:",
      "- A (recommended): Yes, today.",
      "- B: No, wait for the soak.",
      "",
      "The owner's answer:",
      "B: No, wait for the soak.",
      "Soak until Friday.",
    ].join("\n"),
  );
  const bare = askDelivery({ ...ASK, options: [] }, { option: null, text: "No." });
  assert.ok(!bare.includes("Options:"));
});

test("the Linear record holds the question and the answer, and closes no block", () => {
  const record = askRecord(ASK, { option: "A", text: "" });
  assert.equal(
    record,
    [
      "Answer to bb question bbq_test1 from thread thr_test9 (asked 2026-01-05 10:00 UTC)",
      "",
      "Question:",
      "Ship the cache change today?",
      "It touches `the router`.",
      "",
      "Options:",
      "- A (recommended): Yes, today.",
      "- B: No, wait for the soak.",
      "",
      "Answer:",
      "A: Yes, today.",
    ].join("\n"),
  );
  assert.equal(commentRole({ body: record, author: "user" }), "answer");
  assert.deepEqual(answeredBlocks(record), []);
});

test("an answer to Linear blocks is delivered with its issue and comment", () => {
  assert.equal(
    blockDelivery("TEAM-1", "c-123", "Answers to the questions of 2026-01-05 (block q1 rev 0123456789ab)\n\nQ1. A"),
    [
      "[sgc-steward] Answer to your questions on TEAM-1, posted as Linear comment c-123",
      "",
      "Answers to the questions of 2026-01-05 (block q1 rev 0123456789ab)",
      "",
      "Q1. A",
    ].join("\n"),
  );
});
