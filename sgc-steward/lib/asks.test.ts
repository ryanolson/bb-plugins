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
  checkLabels,
  checkQuestion,
  checkReason,
  isThreadId,
  withdrawalNotice,
  withdrawalRecord,
  type Ask,
} from "./asks.ts";
import { NOTE_OPTION, PAUSE_OPTION, cardChoices } from "./choices.ts";
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
  labels: [],
  askedAt: Date.parse("2026-01-05T10:00:00Z"),
};

test("a question is trimmed and must say something, within the limit", () => {
  assert.equal(checkQuestion("  Ship it?\n"), "Ship it?");
  assert.throws(() => checkQuestion(" \n "), /the question is empty/);
  assert.throws(() => checkQuestion("x".repeat(ASK_LIMITS.questionChars + 1)), /over 4000 characters/);
});

test("options get letters in order, then the Pause option, and the recommendation is the one named", () => {
  const letters = (options: ReturnType<typeof askOptions>) => options.map((option) => [option.letter, option.recommended]);
  assert.deepEqual(askOptions([" Yes. ", "No."], "A").slice(0, 2), [
    { letter: "A", text: "Yes.", recommended: true },
    { letter: "B", text: "No.", recommended: false },
  ]);
  assert.deepEqual(letters(askOptions(["Yes.", "No."], "B")), [["A", false], ["B", true], ["C", false]]);
  assert.deepEqual(letters(askOptions(["Yes.", "No."], null)), [["A", false], ["B", false], ["C", false]]);
  assert.throws(() => askOptions(Array.from({ length: ASK_LIMITS.options + 1 }, (_, n) => `o${n}`), "A"), /1 to 3 options/);
  assert.throws(() => askOptions(["Yes.", " "], "A"), /option B is empty/);
  assert.throws(() => askOptions(["x".repeat(ASK_LIMITS.optionChars + 1)], "A"), /option A is over 500 characters/);
  assert.throws(() => askOptions(["Yes.", "No."], "C"), /there is no option C to recommend/);
  assert.throws(() => askOptions([], null), /a question takes 1 to 3 options/);
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
  assert.equal(answerText(ASK, { option: "C", text: "" }), `C: ${PAUSE_OPTION}`, "the Pause choice the card adds");
  assert.throws(() => answerText(ASK, { option: "D", text: "" }), /there is no option D/);
  assert.throws(() => answerText(ASK, { option: null, text: "  " }), /the answer is empty/);
});

test("picking the note choice answers with the note, which it requires", () => {
  const noOptions: Ask = { ...ASK, options: [] };
  assert.equal(answerText(noOptions, { option: "A", text: "  Ship Friday.  " }), "Ship Friday.");
  assert.throws(() => answerText(noOptions, { option: "A", text: "  " }), /"Answer in the note below" takes an answer in the note/);
  assert.equal(answerText(noOptions, { option: "B", text: "" }), `B: ${PAUSE_OPTION}`);
});

test("a stored ask created without options offers the note and keeps its Pause letter", () => {
  const stored: Ask = { ...ASK, options: [{ letter: "A", text: PAUSE_OPTION, recommended: false }] };
  assert.equal(answerText(stored, { option: "A", text: "" }), `A: ${PAUSE_OPTION}`);
  const note = cardChoices(stored.options).find((choice) => choice.text === NOTE_OPTION);
  assert.ok(note, "the stored Pause choice is the only option on this card");
  assert.equal(answerText(stored, { option: note.letter, text: "Ship Friday." }), "Ship Friday.");
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

test("a withdrawal reason is trimmed and must say something, within the limit", () => {
  assert.equal(checkReason("  Decided elsewhere.\n"), "Decided elsewhere.");
  assert.throws(() => checkReason(" \n "), /the reason is empty/);
  assert.throws(() => checkReason("x".repeat(ASK_LIMITS.reasonChars + 1)), /over 2000 characters/);
});

test("a withdrawal notice starts with its prefix and gives the reason and the question", () => {
  const notice = withdrawalNotice(ASK, "thr_steward", "The router change shipped.");
  assert.ok(notice.startsWith("[sgc-steward] Withdrawn bbq_test1\n"), notice);
  assert.match(notice, /thr_steward/);
  assert.match(notice, /Reason:\nThe router change shipped\./);
  assert.ok(notice.includes(ASK.question));
});

test("a withdrawal record starts with the record header, so it closes no block", () => {
  const record = withdrawalRecord(ASK, "thr_steward", "The router change shipped.", Date.parse("2026-01-05T11:30:00Z"));
  assert.equal(record.split("\n")[0], "Answer to bb question bbq_test1 from thread thr_test9 (asked 2026-01-05 10:00 UTC): withdrawn");
  assert.equal(commentRole({ body: record, author: "user" }), "answer");
  assert.deepEqual(answeredBlocks(record), []);
  assert.match(record, /Withdrawn by the steward, thread thr_steward, at 2026-01-05 11:30 UTC\. Reason:\nThe router change shipped\./);
  assert.ok(record.includes(ASK.question));
  assert.match(record, /- A \(recommended\): Yes, today\./);
});

test("a label is trimmed and kept in its spelling, within the limits", () => {
  assert.deepEqual(checkLabels([" infra "], null), ["infra"]);
  assert.throws(() => checkLabels(["  "], null), /the label is empty/);
  assert.throws(() => checkLabels(["x".repeat(ASK_LIMITS.labelChars + 1)], null), new RegExp(`over ${ASK_LIMITS.labelChars} characters`));
  assert.throws(() => checkLabels(["two\nlines"], null), /control character/);
  assert.throws(() => checkLabels(["tab\there"], null), /control character/);
  assert.throws(() => checkLabels(["a", "b"], null), /exactly 1 label/);
});
