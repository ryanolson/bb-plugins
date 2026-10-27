import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerCommentId,
  answerFor,
  answerHeader,
  answeredBlocks,
  commentRole,
  composeAnswer,
  composeTextAnswer,
  openBlocks,
  parseQuestionBlock,
  parseSignature,
  type LinearComment,
  type QuestionBlock,
} from "./questions.ts";

let clock = Date.parse("2026-01-05T10:00:00Z");
/** A comment one minute after the previous one, so order is unambiguous. */
function comment(id: string, body: string, extra: Partial<LinearComment> = {}): LinearComment {
  clock += 60_000;
  return { id, body, createdAt: new Date(clock).toISOString(), author: "user", parentId: null, ...extra };
}

const QUESTIONS = [
  "[agent:claude-code thr_test1] Questions 2026-01-05",
  "Context line one.",
  "Q1. Which scale do estimates use?",
  "- A (recommended): Powers of two.",
  "- B: Small, medium, large.",
  "Q2. Which project goes first?",
  "- A: The router.",
  "- B (recommended): The cells.",
  "- C: Both, in rank order.",
  "Q3. Anything else?",
].join("\n");

function parsed(block: QuestionBlock | null) {
  assert.ok(block, "expected a question block");
  assert.equal(block.format, "parsed", block.format === "raw" ? block.problem : "");
  return block as Extract<QuestionBlock, { format: "parsed" }>;
}

function raw(block: QuestionBlock | null) {
  assert.ok(block, "expected a question block");
  assert.equal(block.format, "raw");
  return block as Extract<QuestionBlock, { format: "raw" }>;
}

// --- signature and roles -------------------------------------------------

test("the signature names the agent and its thread", () => {
  assert.deepEqual(parseSignature("[agent:claude-code thr_test1] Questions 2026-01-05"), {
    agent: "claude-code",
    threadId: "thr_test1",
    rest: " Questions 2026-01-05",
  });
  assert.deepEqual(parseSignature("[agent:codex]\nhello"), { agent: "codex", threadId: null, rest: "" });
  assert.equal(parseSignature("  \n[agent:devin thr_x] hi")?.agent, "devin", "leading blank lines are fine");
});

test("only a body that starts with [agent: is signed", () => {
  assert.equal(parseSignature("Thanks. [agent:codex thr_x] said so."), null);
  assert.equal(parseSignature("\\[agent:codex thr_x] escaped by an editor"), null);
  assert.equal(parseSignature("[Agent:codex thr_x] wrong case"), null);
  assert.equal(parseSignature("[agent: thr_x] no agent name"), null);
});

test("a signed comment is the agent's, an unsigned one is Ryan's answer, a bot's counts for nothing", () => {
  assert.equal(commentRole({ body: "[agent:codex thr_x] Run report", author: "user" }), "signed");
  assert.equal(commentRole({ body: "Use the cells.", author: "user" }), "answer");
  assert.equal(commentRole({ body: "Linked a pull request", author: "bot" }), "ignored");
  assert.equal(commentRole({ body: "[agent:codex thr_x] from an app", author: "bot" }), "ignored");
});

// --- the question format -------------------------------------------------

test("a question block parses into context, questions, and options with the recommended one first", () => {
  const block = parsed(parseQuestionBlock(comment("c1", QUESTIONS), "checkin"));
  assert.equal(block.commentId, "c1");
  assert.equal(block.agent, "claude-code");
  assert.equal(block.threadId, "thr_test1");
  assert.equal(block.date, "2026-01-05");
  assert.equal(block.context, "Context line one.");
  assert.deepEqual(block.questions, [
    {
      number: 1,
      text: "Which scale do estimates use?",
      options: [
        { letter: "A", text: "Powers of two.", recommended: true },
        { letter: "B", text: "Small, medium, large.", recommended: false },
      ],
    },
    {
      number: 2,
      text: "Which project goes first?",
      options: [
        { letter: "B", text: "The cells.", recommended: true },
        { letter: "A", text: "The router.", recommended: false },
        { letter: "C", text: "Both, in rank order.", recommended: false },
      ],
    },
    { number: 3, text: "Anything else?", options: [] },
  ]);
});

test("bullets may be -, * or +, and recommended may be any case", () => {
  const body = [
    "[agent:codex thr_x] Questions",
    "Q1. Pick one.",
    "* A (Recommended): First.",
    "+ B: Second.",
    "- C (RECOMMENDED): no, two recommended is malformed.",
  ].join("\n");
  assert.equal(raw(parseQuestionBlock(comment("c", body), "checkin")).problem, "Q1 recommends more than one option");
  const ok = body.split("\n").slice(0, 4).join("\n");
  const block = parsed(parseQuestionBlock(comment("c", ok), "checkin"));
  assert.equal(block.date, null);
  assert.deepEqual(block.questions[0]?.options.map((option) => [option.letter, option.recommended]), [
    ["A", true],
    ["B", false],
  ]);
});

test("continuation lines join the question or option above them", () => {
  const body = [
    "[agent:claude-code thr_x] Questions 2026-01-05",
    "Q1. Which scale",
    "do estimates use?",
    "- A (recommended): Powers of two,",
    "  as the skill says.",
    "- B: Small, medium, large.",
    "I lean A.",
    "",
    "Q2. Next?",
  ].join("\r\n");
  const block = parsed(parseQuestionBlock(comment("c", body), "checkin"));
  assert.equal(block.questions[0]?.text, "Which scale\ndo estimates use?\nI lean A.");
  assert.equal(block.questions[0]?.options[0]?.text, "Powers of two,\nas the skill says.");
  assert.equal(block.questions[1]?.text, "Next?");
});

test("the blank-line form in the README parses to the same questions", () => {
  const spaced = [
    "[agent:claude-code thr_test1] Questions 2026-01-05",
    "",
    "Context line one.",
    "",
    "Q1. Which scale do estimates use?",
    "- A (recommended): Powers of two.",
    "- B: Small, medium, large.",
    "",
    "Q2. Which project goes first?",
    "- A: The router.",
    "- B (recommended): The cells.",
    "- C: Both, in rank order.",
    "",
    "Q3. Anything else?",
  ].join("\n");
  const tight = parsed(parseQuestionBlock(comment("c1", QUESTIONS), "checkin"));
  const block = parsed(parseQuestionBlock(comment("c2", spaced), "checkin"));
  assert.equal(block.date, "2026-01-05");
  assert.equal(block.context, tight.context);
  assert.deepEqual(block.questions, tight.questions);
});

test("a question that Linear folds into the option above it still parses", () => {
  // A line right under a list item is a lazy continuation of that item, so
  // Linear can store it indented.
  const body = ["[agent:a thr_x] Questions 2026-01-05", "Q1. Ship?", "  - A: Yes.", "  - B: No.", "  Q2. Anything else?"].join("\n");
  const block = parsed(parseQuestionBlock(comment("c", body), "checkin"));
  assert.deepEqual(block.questions, [
    {
      number: 1,
      text: "Ship?",
      options: [
        { letter: "A", text: "Yes.", recommended: false },
        { letter: "B", text: "No.", recommended: false },
      ],
    },
    { number: 2, text: "Anything else?", options: [] },
  ]);
  const unsignedHeader = ["[agent:a thr_x] Run 2026-01-05", "- A: an option-like line", "  Q1. Indented question?"].join("\n");
  assert.equal(parsed(parseQuestionBlock(comment("c", unsignedHeader), "checkin")).questions[0]?.text, "Indented question?");
});

test("a block's revision follows its context, questions, options, and signed thread", () => {
  const block = parsed(parseQuestionBlock(comment("c1", QUESTIONS), "checkin"));
  assert.match(block.revision, /^[0-9a-f]{12}$/);
  assert.equal(parsed(parseQuestionBlock(comment("c2", QUESTIONS), "checkin")).revision, block.revision, "same content, same revision");
  const swapped = QUESTIONS.replace("- A (recommended): Powers of two.\n- B: Small, medium, large.", "- A (recommended): Small, medium, large.\n- B: Powers of two.");
  assert.notEqual(parsed(parseQuestionBlock(comment("c1", swapped), "checkin")).revision, block.revision);
  const recommended = QUESTIONS.replace("- A (recommended): Powers of two.\n- B: Small, medium, large.", "- A: Powers of two.\n- B (recommended): Small, medium, large.");
  assert.notEqual(parsed(parseQuestionBlock(comment("c1", recommended), "checkin")).revision, block.revision);
  const context = QUESTIONS.replace("Context line one.", "Context line two.");
  assert.notEqual(parsed(parseQuestionBlock(comment("c1", context), "checkin")).revision, block.revision, "the context is part of what is answered");
  const resigned = QUESTIONS.replace("thr_test1", "thr_other");
  assert.notEqual(parsed(parseQuestionBlock(comment("c1", resigned), "checkin")).revision, block.revision, "the signed thread receives the answer");
  const rawOne = raw(parseQuestionBlock(comment("r1", "[agent:codex thr_x] Which key?"), "needs-decision"));
  const rawTwo = raw(parseQuestionBlock(comment("r1", "[agent:codex thr_x] Which tenant key?"), "needs-decision"));
  assert.notEqual(rawOne.revision, rawTwo.revision, "a raw block's revision follows its text");
});

test("bullets before Q1 are context, not options", () => {
  const body = ["[agent:claude-code thr_x] Questions 2026-01-05", "- A: not an option yet", "Q1. Go?"].join("\n");
  const block = parsed(parseQuestionBlock(comment("c", body), "checkin"));
  assert.equal(block.context, "- A: not an option yet");
  assert.deepEqual(block.questions[0]?.options, []);
});

test("malformed blocks fall back to raw with the reason", () => {
  const cases: Array<[string[], string]> = [
    [["[agent:a thr_x] Questions", "Q1. One?", "Q3. Three?"], "expected Q2 but found Q3"],
    [["[agent:a thr_x] Questions", "Q2. Two?"], "expected Q1 but found Q2"],
    [["[agent:a thr_x] Questions", "Q1. One?", "- B: skipped A"], "Q1: expected option A but found B"],
    [["[agent:a thr_x] Questions", "Q1. One?", "- A (default): not a marker"], "Q1 option A: (default) is not (recommended)"],
    [["[agent:a thr_x] Questions", "Q1. One?", "- A:"], "Q1 option A has no text"],
    [["[agent:a thr_x] Questions", "1. Old numbering?"], "no Q1. line"],
  ];
  for (const [lines, problem] of cases) {
    const block = raw(parseQuestionBlock(comment("c", lines.join("\n")), "checkin"));
    assert.equal(block.problem, problem, lines.join(" | "));
    assert.equal(block.body, lines.join("\n"));
  }
});

test("on a check-in, a signed comment is a question block only with Q lines or a Questions header", () => {
  const digest = [
    "[agent:claude-code thr_x] Digest 2026-01-05",
    "1. needs-decision issues: none.",
    "2. Triage: 9 issues wait for you.",
  ].join("\n");
  assert.equal(parseQuestionBlock(comment("c", digest), "checkin"), null);
  assert.equal(parseQuestionBlock(comment("c", "[agent:a thr_x] Questions answered today: 2"), "checkin"), null);
  assert.equal(parseQuestionBlock(comment("c", "Q1. unsigned"), "checkin"), null);
  const noHeader = ["[agent:a thr_x] Run 2026-01-05", "Q1. Still a question?"].join("\n");
  const block = parsed(parseQuestionBlock(comment("c", noHeader), "checkin"));
  assert.equal(block.context, "Run 2026-01-05");
  const oneLine = parsed(parseQuestionBlock(comment("c", "[agent:a thr_x] Q1. Ship it today?"), "checkin"));
  assert.equal(oneLine.questions[0]?.text, "Ship it today?");
});

test("on a needs-decision issue, any signed comment is a block: parsed when it has Q lines, raw otherwise", () => {
  const free = "[agent:codex thr_x] Should the cache key include the tenant?";
  const block = raw(parseQuestionBlock(comment("c", free), "needs-decision"));
  assert.equal(block.problem, "no Q1. line");
  assert.equal(block.agent, "codex");
  const structured = ["[agent:codex thr_x] Decision needed", "Q1. Include the tenant?", "- A (recommended): Yes.", "- B: No."];
  assert.equal(parsed(parseQuestionBlock(comment("c", structured.join("\n")), "needs-decision")).questions.length, 1);
  assert.equal(parseQuestionBlock(comment("c", "unsigned"), "needs-decision"), null);
});

// --- open or answered ----------------------------------------------------

test("a check-in block stays open until a later unsigned comment", () => {
  const first = comment("q1", QUESTIONS);
  const answer = comment("a1", "Q1. A");
  const second = comment("q2", QUESTIONS.replace("2026-01-05", "2026-01-06"));
  assert.deepEqual(openBlocks("checkin", [first]).map((block) => block.commentId), ["q1"]);
  assert.deepEqual(openBlocks("checkin", [first, answer, second]).map((block) => block.commentId), ["q2"]);
  assert.deepEqual(openBlocks("checkin", [first, second]).map((block) => block.commentId), ["q1", "q2"]);
});

test("order comes from createdAt, not from the order Linear returns", () => {
  const first = comment("q1", QUESTIONS);
  const answer = comment("a1", "Q1. A");
  const second = comment("q2", QUESTIONS);
  assert.deepEqual(openBlocks("checkin", [second, answer, first]).map((block) => block.commentId), ["q2"]);
});

test("an unsigned reply in a thread answers; a bot comment and a signed digest do not", () => {
  const block = comment("q1", QUESTIONS);
  const digest = comment("d1", "[agent:claude-code thr_x] Digest\n1. nothing");
  const bot = comment("b1", "A pull request was linked", { author: "bot" });
  assert.deepEqual(openBlocks("checkin", [block, digest, bot]).map((open) => open.commentId), ["q1"]);
  const reply = comment("r1", "Go with A", { parentId: "q1" });
  assert.deepEqual(openBlocks("checkin", [block, digest, bot, reply]), []);
});

test("a needs-decision question is the latest signed comment, open until an unsigned comment follows it", () => {
  const older = comment("s1", "[agent:codex thr_x] First take on the question");
  const latest = comment("s2", "[agent:codex thr_x] Which tenant key?");
  assert.deepEqual(openBlocks("needs-decision", [older, latest]).map((block) => block.commentId), ["s2"]);
  const answer = comment("a1", "Use the org id.");
  assert.deepEqual(openBlocks("needs-decision", [older, latest, answer]), []);
  assert.deepEqual(openBlocks("needs-decision", [answer]), []);
  assert.deepEqual(openBlocks("needs-decision", []), []);
});

test("an answer that names its blocks closes only those blocks, at their revision", () => {
  const first = comment("q1", QUESTIONS);
  const second = comment("q2", QUESTIONS.replace("Which scale do estimates use?", "May I delete the project?"));
  const answered = parsed(parseQuestionBlock(first, "checkin"));
  const reply = comment("a1", `Answers to the questions of 2026-01-05 (block q1 rev ${answered.revision})\n\nQ1. A`);
  assert.deepEqual(answeredBlocks(reply.body), [{ blockId: "q1", revision: answered.revision, question: null }]);
  assert.deepEqual(openBlocks("checkin", [first, second, reply]).map((block) => block.commentId), ["q2"]);

  const stale = comment("a2", "Answers to the questions of 2026-01-05 (block q2 rev 000000000000)\n\nQ1. A");
  assert.deepEqual(openBlocks("checkin", [first, second, reply, stale]).map((block) => block.commentId), ["q2"], "another revision answers nothing");

  const plain = comment("a3", "Go with A everywhere.");
  assert.equal(answeredBlocks(plain.body), null);
  assert.deepEqual(openBlocks("checkin", [first, second, plain]), [], "a plain answer closes every block before it");
  const mention = comment("a4", "I saw (block q2 rev 000000000000) in a header once.");
  assert.equal(answeredBlocks(mention.body), null, "only answer header lines name blocks");
});

test("an answer can name one question of a block, which stays open until each question has an answer", () => {
  const question = comment("q1", QUESTIONS);
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const second = comment("a1", `Answer to the questions of 2026-01-05 (block q1 rev ${block.revision}), Q2\n\nQ2. B: The cells.`);
  assert.deepEqual(answeredBlocks(second.body), [{ blockId: "q1", revision: block.revision, question: 2 }]);
  const open = openBlocks("checkin", [question, second]);
  assert.deepEqual(open.map((left) => [left.commentId, left.revision, parsed(left).questions.map((asked) => asked.number)]), [["q1", block.revision, [1, 3]]]);

  const rest = comment(
    "a2",
    [
      `Answer to the questions of 2026-01-05 (block q1 rev ${block.revision}), Q1`,
      `Answer to the questions of 2026-01-05 (block q1 rev ${block.revision}), Q3`,
      "",
      "Q1. A: Powers of two.",
      "",
      "Q3. No.",
    ].join("\n"),
  );
  assert.deepEqual(openBlocks("checkin", [question, second, rest]), [], "every question has an answer");
  assert.deepEqual(openBlocks("checkin", [question, second, comment("a3", "Go with A.")]), [], "a plain answer still closes the whole block");
});

test("an edit reopens the questions answered before it, and a raw block has no numbered questions", () => {
  const question = comment("q1", QUESTIONS);
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const answer = comment("a1", `Answer to the questions of 2026-01-05 (block q1 rev ${block.revision}), Q2\n\nQ2. B: The cells.`);
  const edited = { ...question, body: QUESTIONS.replace("Anything else?", "Anything else at all?") };
  assert.deepEqual(
    openBlocks("checkin", [edited, answer]).map((left) => parsed(left).questions.map((asked) => asked.number)),
    [[1, 2, 3]],
    "the answer names the old revision",
  );

  const free = comment("r1", "[agent:codex thr_x] Questions 2026-01-07\nfree form");
  const rawBlock = raw(parseQuestionBlock(free, "checkin"));
  const numbered = comment("a2", `Answer to the questions of 2026-01-07 (block r1 rev ${rawBlock.revision}), Q1\n\nQ1. Yes.`);
  assert.deepEqual(openBlocks("checkin", [free, numbered]).map((left) => left.commentId), ["r1"]);
});

test("a todo marked done or reopened answers no Linear block, but only as the first line", () => {
  for (const body of ["Done (from the SGC page)", "Done (from the SGC page)\n\nLogged in.", "Reopened (from the SGC page)"]) {
    assert.deepEqual(answeredBlocks(body), [], body);
    assert.deepEqual(openBlocks("checkin", [comment("q1", QUESTIONS), comment("d1", body)]).map((open) => open.commentId), ["q1"]);
  }
  assert.equal(answeredBlocks("Go with A.\n\nDone (from the SGC page)"), null, "a plain answer that quotes the marker still answers");
});

test("a record of a bb question answers no Linear block", () => {
  const record = ["Answer to bb question bbq_test1 from thread thr_test9 (asked 2026-01-05 10:00 UTC)", "", "Question:", "Ship it?", "", "Answer:", "A: Yes."].join("\n");
  assert.equal(commentRole({ body: record, author: "user" }), "answer");
  assert.deepEqual(answeredBlocks(record), [], "a plugin answer that names no blocks");
  const answered = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const quoting = record.replace("Ship it?", `May I post this?\n\nAnswers to the questions of 2026-01-05 (block q1 rev ${answered.revision})`);
  assert.deepEqual(answeredBlocks(quoting), [], "a header the record quotes names nothing");
  assert.equal(answeredBlocks(`Go with A.\n\n${record}`), null, "the record header counts only on the first line");

  const block = comment("q1", QUESTIONS);
  assert.deepEqual(openBlocks("checkin", [block, comment("r1", record)]).map((open) => open.commentId), ["q1"]);
  const decision = comment("d1", "[agent:codex thr_x] Which tenant key?");
  assert.deepEqual(openBlocks("needs-decision", [decision, comment("r2", record)]).map((open) => open.commentId), ["d1"]);
  assert.deepEqual(openBlocks("checkin", [comment("q2", QUESTIONS), comment("a1", "Go with A.")]), [], "a plain answer still closes every block");
});

test("a needs-decision question stays open when the answer names an older block", () => {
  const older = comment("d1", "[agent:codex thr_x] Which tenant key?");
  const newer = comment("d2", "[agent:codex thr_x] May I drop the old table?");
  const olderBlock = raw(parseQuestionBlock(older, "needs-decision"));
  const reply = comment("a1", `Answer to the question of 2026-01-05 (block d1 rev ${olderBlock.revision})\n\nThe org id.`);
  assert.deepEqual(openBlocks("needs-decision", [older, newer, reply]).map((block) => block.commentId), ["d2"]);
  assert.deepEqual(openBlocks("needs-decision", [older, reply]), []);
});

// --- composing the answer ------------------------------------------------

test("an answer to every question of a block names the block, numbered to match", () => {
  const block = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const body = composeAnswer(
    [block],
    [
      {
        blockId: "q1",
        revision: block.revision,
        answers: [
          { number: 1, option: "A", text: "" },
          { number: 2, option: "B", text: "Start with the cells project." },
          { number: 3, option: null, text: "No." },
        ],
      },
    ],
  );
  assert.equal(
    body,
    [
      `Answers to the questions of 2026-01-05 (block q1 rev ${block.revision})`,
      "",
      "Q1. A: Powers of two.",
      "",
      "Q2. B: The cells.",
      "Start with the cells project.",
      "",
      "Q3. No.",
    ].join("\n"),
  );
});

test("an answer to some questions of a block names each one, and says nothing of the rest", () => {
  const block = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const one = composeAnswer([block], [{ blockId: "q1", revision: block.revision, answers: [{ number: 2, option: "B", text: "Start with the cells project." }] }]);
  assert.equal(one, [`Answer to the questions of 2026-01-05 (block q1 rev ${block.revision}), Q2`, "", "Q2. B: The cells.", "Start with the cells project."].join("\n"));
  const two = composeAnswer(
    [block],
    [
      {
        blockId: "q1",
        revision: block.revision,
        answers: [
          { number: 3, option: null, text: "No." },
          { number: 1, option: "A", text: "" },
          { number: 2, option: null, text: "  " },
        ],
      },
    ],
  );
  assert.deepEqual(answeredBlocks(two), [
    { blockId: "q1", revision: block.revision, question: 1 },
    { blockId: "q1", revision: block.revision, question: 3 },
  ]);
  assert.match(two, /\n\nQ1\. A: Powers of two\.\n\nQ3\. No\.$/);
});

test("a typed answer needs no option, and raw blocks take free text", () => {
  const block = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const rawBlock = raw(parseQuestionBlock(comment("q2", "[agent:codex thr_x] Questions 2026-01-07\nfree form"), "checkin"));
  const body = composeAnswer(
    [block, rawBlock],
    [
      { blockId: "q1", revision: block.revision, answers: [{ number: 3, option: null, text: "Ship it\non Friday." }] },
      { blockId: "q2", revision: rawBlock.revision, answers: [], text: "Yes, go ahead." },
    ],
  );
  const at = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  assert.equal(
    body,
    [
      `Answer to the questions of 2026-01-05, posted ${at(block.createdAt)} (block q1 rev ${block.revision}), Q3`,
      "",
      "Q3. Ship it",
      "on Friday.",
      "",
      `Answer to the question of 2026-01-07, posted ${at(rawBlock.createdAt)} (block q2 rev ${rawBlock.revision})`,
      "",
      "Yes, go ahead.",
    ].join("\n"),
  );
});

test("a composed answer always reads as unsigned, even when the text starts with a signature", () => {
  const question = comment("q1", QUESTIONS);
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const body = composeAnswer([block], [{ blockId: "q1", revision: block.revision, answers: [{ number: 1, option: null, text: "[agent:x] sneaky" }] }]);
  assert.equal(commentRole({ body, author: "user" }), "answer");
  assert.deepEqual(openBlocks("checkin", [question, comment("a1", body)]).map((left) => parsed(left).questions.map((asked) => asked.number)), [[2, 3]]);
});

test("a typed answer from the CLI gets headers that name every block it answers", () => {
  const block = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const other = raw(parseQuestionBlock(comment("q2", "[agent:codex thr_x] Questions 2026-01-07\nfree form"), "checkin"));
  const one = composeTextAnswer([block], "  Q1. A\nQ2. The cells.\n");
  assert.equal(one, `Answers to the questions of 2026-01-05 (block q1 rev ${block.revision})\n\nQ1. A\nQ2. The cells.`);
  const both = composeTextAnswer([block, other], "Q1. A");
  assert.deepEqual(answeredBlocks(both), [
    { blockId: "q1", revision: block.revision, question: null },
    { blockId: "q2", revision: other.revision, question: null },
  ]);
  assert.equal(commentRole({ body: both, author: "user" }), "answer");
  assert.throws(() => composeTextAnswer([block], " \n "), /the answer is empty/);
});

test("an answer's comment id comes from the issue and the answer, as a UUID v4", () => {
  const body = "Answers to the questions of 2026-01-05 (block q1 rev 0123456789ab)\n\nQ1. A";
  const id = answerCommentId("issue-1", body);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(answerCommentId("issue-1", body), id, "a retry or a resubmission of the same answer reuses the id");
  assert.notEqual(answerCommentId("issue-1", body.replace("Q1. A", "Q1. B")), id);
  assert.notEqual(answerCommentId("issue-1", body.replace("rev 0123456789ab", "rev 0123456789ac")), id);
  assert.notEqual(answerCommentId("issue-2", body), id);
});

test("composeAnswer refuses answers that do not fit the open blocks", () => {
  const block = parsed(parseQuestionBlock(comment("q1", QUESTIONS), "checkin"));
  const rawBlock = raw(parseQuestionBlock(comment("q2", "[agent:codex thr_x] Questions\nfree"), "checkin"));
  const attempt = (answers: Parameters<typeof composeAnswer>[1]) => () => composeAnswer([block], answers);
  assert.throws(attempt([]), /missing answers for block q1/);
  assert.throws(attempt([{ blockId: "zz", revision: block.revision, answers: [] }]), /block zz is not open/);
  assert.throws(attempt([{ blockId: "q1", revision: "000000000000", answers: [{ number: 1, option: "A", text: "" }] }]), /block q1 changed after the answers were written/);
  assert.throws(attempt([{ blockId: "q1", revision: block.revision, answers: [{ number: 9, option: null, text: "x" }] }]), /Q9 is not a question/);
  assert.throws(attempt([{ blockId: "q1", revision: block.revision, answers: [{ number: 1, option: "D", text: "" }] }]), /Q1 has no option D/);
  assert.throws(attempt([{ blockId: "q1", revision: block.revision, answers: [{ number: 3, option: "A", text: "" }] }]), /Q3 has no option A/);
  assert.throws(
    attempt([
      {
        blockId: "q1",
        revision: block.revision,
        answers: [
          { number: 1, option: "A", text: "" },
          { number: 1, option: "B", text: "" },
        ],
      },
    ]),
    /Q1 is answered twice/,
  );
  assert.throws(attempt([{ blockId: "q1", revision: block.revision, answers: [{ number: 1, option: null, text: "  " }] }]), /nothing to post/);
  assert.throws(attempt([{ blockId: "q1", revision: block.revision, answers: [] }]), /nothing to post/);
  assert.throws(() => composeAnswer([rawBlock], [{ blockId: "q2", revision: rawBlock.revision, answers: [], text: " " }]), /nothing to post/);
  assert.throws(() => composeAnswer([rawBlock], [{ blockId: "q2", revision: rawBlock.revision, answers: [{ number: 1, option: null, text: "x" }] }]), /block q2 is not in the question format/);
});

// --- answering what is still open ------------------------------------------

test("an answer is written from the whole block, and only while all it names is open", () => {
  const question = comment("q1", QUESTIONS);
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const ref = [{ blockId: "q1", revision: block.revision }];
  const answer = (number: number, text: string) => (blocks: QuestionBlock[]) =>
    composeAnswer(blocks, [{ blockId: "q1", revision: block.revision, answers: [{ number, option: null, text }] }]);

  const first = answerFor(ref, openBlocks("checkin", [question]), [question], answer(1, "Powers of two."));
  assert.ok(first);
  assert.deepEqual(first.blocks.map((named) => named.commentId), ["q1"]);
  const second = comment("a1", answer(2, "The cells.")([block]));
  const third = comment("a2", answer(3, "No.")([block]));
  const comments = [question, second, third];
  const open = openBlocks("checkin", comments);
  assert.deepEqual(open.map((left) => parsed(left).questions.map((asked) => asked.number)), [[1]]);

  const last = answerFor(ref, open, comments, answer(1, "Powers of two."));
  assert.ok(last);
  assert.equal(last.body, answer(1, "Powers of two.")([block]), "the last open question still names itself, as a retry would write it");
  assert.equal(parsed(last.blocks[0]!).questions.length, 3, "composed from the whole block");
  assert.equal(answerFor(ref, open, comments, answer(2, "The router.")), null, "Q2 has an answer already");
  assert.equal(answerFor([{ blockId: "q1", revision: "000000000000" }], open, comments, answer(1, "x")), null, "another revision");
  assert.equal(answerFor([{ blockId: "zz", revision: block.revision }], open, comments, answer(1, "x")), null, "no such block");
  assert.throws(() => answerFor(ref, open, comments, answer(9, "x")), /Q9 is not a question/);
});

// --- the owner's words never answer anything --------------------------------

test("a line of the owner's text that reads as an answer header is quoted, and answers nothing", () => {
  const question = comment("q1", QUESTIONS);
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const header = (number: number) => answerHeader(block, false, number);
  const notes = [
    `See the other one:\n\n${header(2)}`,
    `Indented:\n    ${header(3)}`,
    // A lone carriage return, which the parser reads as a line break.
    `Old line end:\r${header(2)}`,
    // A zero-width space, which Linear's rich text might drop.
    `Hidden:\n​${header(3)}`,
  ];
  for (const note of notes) {
    const body = composeAnswer([block], [{ blockId: "q1", revision: block.revision, answers: [{ number: 1, option: "A", text: note }] }]);
    assert.deepEqual(answeredBlocks(body), [{ blockId: "q1", revision: block.revision, question: 1 }], JSON.stringify(note));
    assert.deepEqual(
      openBlocks("checkin", [question, comment("a1", body)]).map((left) => parsed(left).questions.map((asked) => asked.number)),
      [[2, 3]],
      JSON.stringify(note),
    );
  }
  const typed = composeAnswer([block], [{ blockId: "q1", revision: block.revision, answers: [{ number: 1, option: null, text: `Powers of two.\n${header(2)}` }] }]);
  assert.ok(typed.endsWith(`\n\nQ1. Powers of two.\n> ${header(2)}`), "the owner's words are kept, quoted");
});

test("the note of an answer to a whole block cannot close another open block", () => {
  const one = comment("q1", "[agent:claude-code thr_test1] Questions 2026-01-04\nQ1. Ship it?\n- A: Yes.\n- B: No.");
  const other = comment("q2", QUESTIONS);
  const answered = parsed(parseQuestionBlock(one, "checkin"));
  const open = parsed(parseQuestionBlock(other, "checkin"));
  const body = composeAnswer([answered], [{ blockId: "q1", revision: answered.revision, answers: [{ number: 1, option: "A", text: `As in:\n${answerHeader(open, false)}` }] }]);
  assert.deepEqual(answeredBlocks(body), [{ blockId: "q1", revision: answered.revision, question: null }]);
  assert.deepEqual(openBlocks("checkin", [one, other, comment("a1", body)]).map((left) => left.commentId), ["q2"]);
});

test("CLI text and the answer to a block in no format quote header lines too", () => {
  const question = comment("q1", QUESTIONS);
  const free = comment("r1", "[agent:codex thr_x] Questions 2026-01-07\nfree form");
  const block = parsed(parseQuestionBlock(question, "checkin"));
  const rawBlock = raw(parseQuestionBlock(free, "checkin"));
  const cli = composeTextAnswer([rawBlock], `Yes.\n${answerHeader(block, false)}`);
  const typed = composeAnswer([rawBlock], [{ blockId: "r1", revision: rawBlock.revision, answers: [], text: `Yes.\n${answerHeader(block, false, 2)}` }]);
  for (const body of [cli, typed]) {
    assert.deepEqual(answeredBlocks(body), [{ blockId: "r1", revision: rawBlock.revision, question: null }]);
    assert.deepEqual(openBlocks("checkin", [question, free, comment("a1", body)]).map((left) => left.commentId), ["q1"]);
  }
});

test("an answer that names two blocks in turn, as the plugin wrote them before, still closes both", () => {
  const first: LinearComment = { id: "q1", body: QUESTIONS, createdAt: "2026-01-05T10:00:00.000Z", author: "user", parentId: null };
  const second: LinearComment = { id: "q2", body: "[agent:codex thr_x] Questions 2026-01-07\nfree form", createdAt: "2026-01-07T09:30:00.000Z", author: "user", parentId: null };
  assert.equal(parsed(parseQuestionBlock(first, "checkin")).revision, "cf70f782b81a");
  assert.equal(raw(parseQuestionBlock(second, "checkin")).revision, "3334b12389e5");
  // Written by the plugin at a243b78: each block's header follows the answers to the block before it.
  const answer: LinearComment = {
    id: "a1",
    body: "Answers to the questions of 2026-01-05, posted 2026-01-05 10:00 UTC (block q1 rev cf70f782b81a)\n\nQ1. A: Powers of two.\n\nQ2. No answer.\n\nQ3. No answer.\n\nAnswer to the question of 2026-01-07, posted 2026-01-07 09:30 UTC (block q2 rev 3334b12389e5)\n\nYes, go ahead.",
    createdAt: "2026-01-08T00:00:00.000Z",
    author: "user",
    parentId: null,
  };
  assert.deepEqual(openBlocks("checkin", [first, second, answer]), []);
});
