import { test } from "node:test";
import assert from "node:assert/strict";
import { answerProgress, announcement, askAnswerInput, orderCards, questionBadge, toAnswerBlocks, withDone, type BlockDraft } from "./panel.ts";
import { composeAnswer, parseQuestionBlock, type QuestionBlock } from "./questions.ts";

function block(id: string, body: string, createdAt: string): QuestionBlock {
  const parsed = parseQuestionBlock({ id, body, createdAt, author: "user", parentId: null }, "checkin");
  assert.ok(parsed);
  return parsed;
}

const parsed = block(
  "q1",
  ["[agent:claude-code thr_test1] Questions 2026-01-05", "Q1. Scale?", "- A (recommended): Powers of two.", "- B: Sizes.", "Q2. Anything else?"].join("\n"),
  "2026-01-05T10:00:00.000Z",
);
const raw = block("q2", "[agent:codex thr_test2] Questions 2026-01-06\nfree form", "2026-01-06T09:30:00.000Z");

test("the panel's drafts become the answer the server composes", () => {
  const drafts: Record<string, BlockDraft> = {
    q1: { options: { 1: "B" }, texts: { 1: "  ", 2: "Ship Friday." }, raw: "" },
    q2: { options: {}, texts: {}, raw: "Yes." },
  };
  const blocks = toAnswerBlocks([parsed, raw], drafts);
  assert.deepEqual(blocks, [
    {
      blockId: "q1",
      revision: parsed.revision,
      answers: [
        { number: 1, option: "B", text: "  " },
        { number: 2, option: null, text: "Ship Friday." },
      ],
    },
    { blockId: "q2", revision: raw.revision, answers: [], text: "Yes." },
  ]);
  assert.equal(
    composeAnswer([parsed, raw], blocks),
    [
      `Answers to the questions of 2026-01-05, posted 2026-01-05 10:00 UTC (block q1 rev ${parsed.revision})`,
      "",
      "Q1. B: Sizes.",
      "",
      "Q2. Ship Friday.",
      "",
      `Answer to the question of 2026-01-06, posted 2026-01-06 09:30 UTC (block q2 rev ${raw.revision})`,
      "",
      "Yes.",
    ].join("\n"),
  );
});

test("a draft keeps the revision it was written against, so an edit since is refused", () => {
  const edited = block(
    "q1",
    ["[agent:claude-code thr_test1] Questions 2026-01-05", "Q1. Scale?", "- A (recommended): Sizes.", "- B: Powers of two.", "Q2. Anything else?"].join("\n"),
    "2026-01-05T10:00:00.000Z",
  );
  assert.notEqual(edited.revision, parsed.revision);
  const drafts: Record<string, BlockDraft> = { q1: { options: { 1: "A" }, texts: {}, raw: "", revision: parsed.revision } };
  const blocks = toAnswerBlocks([edited], drafts);
  assert.equal(blocks[0]?.revision, parsed.revision, "the draft's revision, not the block's new one");
  assert.throws(() => composeAnswer([edited], blocks), /changed after the answers were written/);
  assert.equal(toAnswerBlocks([edited], {})[0]?.revision, edited.revision, "an untouched block sends its own revision");
});

test("untouched questions are left out, and progress counts what has an answer", () => {
  assert.deepEqual(toAnswerBlocks([parsed], {}), [{ blockId: "q1", revision: parsed.revision, answers: [] }]);
  assert.deepEqual(answerProgress([parsed, raw], {}), { answered: 0, total: 3 });
  assert.deepEqual(
    answerProgress([parsed, raw], { q1: { options: {}, texts: { 2: "x" }, raw: "" }, q2: { options: {}, texts: {}, raw: " " } }),
    { answered: 1, total: 3 },
  );
});

test("one new question names its issue or its thread; several are summed up in one notification", () => {
  const note = { id: "q1", source: "linear" as const, label: "TEAM-1", questionCount: 3, preview: "Scale?" };
  assert.deepEqual(announcement([note]), { title: "Steward question on TEAM-1", body: "Scale? (+2 more)" });
  assert.deepEqual(announcement([{ ...note, questionCount: 1 }]), { title: "Steward question on TEAM-1", body: "Scale?" });
  const asked = { id: "bbq_1", source: "ask" as const, label: "Driver: test project", questionCount: 1, preview: "Ship it?" };
  assert.deepEqual(announcement([asked]), { title: "Question from Driver: test project", body: "Ship it?" });
  assert.deepEqual(announcement([note, asked]), {
    title: "2 new questions",
    body: "TEAM-1: Scale?\nDriver: test project: Ship it?",
  });
  const todo = { id: "uuid-TEAM-9", source: "todo" as const, label: "TEAM-9", questionCount: 1, preview: "Log in on the build box" };
  assert.deepEqual(announcement([todo]), { title: "New todo: TEAM-9", body: "Log in on the build box" }, "a todo does not read as a question");
  assert.deepEqual(announcement([todo, { ...todo, id: "uuid-TEAM-10", label: "TEAM-10" }]).title, "2 new todos");
  assert.deepEqual(announcement([note, asked, todo]), {
    title: "2 new questions and 1 new todo",
    body: "TEAM-1: Scale?\nDriver: test project: Ship it?\nTEAM-9: Log in on the build box",
  });
});

test("cards from Linear issues and bb questions come oldest first", () => {
  const issues = [
    { id: "i2", blocks: [raw] },
    { id: "i1", blocks: [parsed, raw] },
  ];
  const asks = [
    { id: "bbq_late", askedAt: Date.parse("2026-01-07T00:00:00Z") },
    { id: "bbq_early", askedAt: Date.parse("2026-01-04T00:00:00Z") },
  ];
  assert.deepEqual(
    orderCards(issues, asks).map((card) => (card.kind === "issue" ? card.issue.id : card.ask.id)),
    ["bbq_early", "i1", "i2", "bbq_late"],
  );
});

test("a bb question's answer is a picked option, typed text, or both", () => {
  assert.equal(askAnswerInput("bbq_1", { option: null, text: "  " }), null);
  assert.deepEqual(askAnswerInput("bbq_1", { option: "B", text: "" }), { id: "bbq_1", option: "B", text: "" });
  assert.deepEqual(askAnswerInput("bbq_1", { option: null, text: "Later." }), { id: "bbq_1", option: null, text: "Later." });
});

test("the badge counts open questions, then flags answers that did not go out, then Linear trouble", () => {
  const base = { configured: true, error: null, issues: [], asks: [], undelivered: [], unposted: [] };
  assert.equal(questionBadge(base), null);
  assert.deepEqual(questionBadge({ ...base, issues: [{ blocks: [parsed, raw] }], asks: [{}] }), { count: 4, tone: "warning", label: "4 open questions" });
  assert.deepEqual(questionBadge({ ...base, asks: [{}] }), { count: 1, tone: "warning", label: "1 open question" });
  assert.deepEqual(questionBadge({ ...base, undelivered: [{}], unposted: [{}] }), { tone: "critical", label: "2 answers did not go out" });
  assert.deepEqual(questionBadge({ ...base, configured: false }), { tone: "critical", label: "SGC Steward needs a Linear API key" });
  assert.deepEqual(questionBadge({ ...base, error: "boom" }), { tone: "critical", label: "SGC Steward cannot read Linear" });
});

test("a new Done of an issue replaces the page's Undo for its earlier Done", () => {
  const first = { issueId: "uuid-1", undo: "t-1" };
  const other = { issueId: "uuid-2", undo: "t-2" };
  const newer = { issueId: "uuid-1", undo: "t-3" };
  assert.deepEqual(withDone(withDone(withDone([], first), other), newer), [other, newer]);
});
