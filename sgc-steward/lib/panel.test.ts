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

test("untouched questions are left out, and progress counts what has an answer", () => {
  assert.deepEqual(toAnswerBlocks([parsed], {}), [{ blockId: "q1", revision: parsed.revision, answers: [] }]);
  assert.deepEqual(answerProgress([parsed, raw], {}), { answered: 0, total: 3 });
  assert.deepEqual(
    answerProgress([parsed, raw], { q1: { options: {}, texts: { 2: "x" }, raw: "" }, q2: { options: {}, texts: {}, raw: " " } }),
    { answered: 1, total: 3 },
  );
});

test("one new block names its issue; several are summed up in one notification", () => {
  const note = { blockId: "q1", issueIdentifier: "TEAM-1", issueTitle: "Daily", questionCount: 3, preview: "Scale?" };
  assert.deepEqual(announcement([note]), { title: "Steward question on TEAM-1", body: "Scale? (+2 more)" });
  assert.deepEqual(announcement([{ ...note, questionCount: 1 }]), { title: "Steward question on TEAM-1", body: "Scale?" });
  assert.deepEqual(announcement([note, { ...note, blockId: "q9", issueIdentifier: "TEAM-2", preview: "Tenant?" }]), {
    title: "2 new steward question blocks",
    body: "TEAM-1: Scale?\nTEAM-2: Tenant?",
  });
});
