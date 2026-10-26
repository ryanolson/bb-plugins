import { test } from "node:test";
import assert from "node:assert/strict";
import { answerProgress, announcement, toAnswerBlocks, type BlockDraft } from "./panel.ts";
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
});
