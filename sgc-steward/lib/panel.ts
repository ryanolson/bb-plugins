// The pure logic behind the Questions page and the notifier, kept out of the
// React code so it can be tested without a DOM.

import type { BlockAnswer, QuestionBlock } from "./questions.ts";

/** What the user picked or typed for one block, keyed by question number. */
export interface BlockDraft {
  options: Record<number, string>;
  texts: Record<number, string>;
  /** The answer to a block that is not in the question format. */
  raw: string;
}

export const EMPTY_DRAFT: BlockDraft = { options: {}, texts: {}, raw: "" };

function hasAnswer(draft: BlockDraft, number: number): boolean {
  return draft.options[number] !== undefined || (draft.texts[number] ?? "").trim() !== "";
}

/** The answer blocks for `questions.answer`; untouched questions are left out. */
export function toAnswerBlocks(blocks: readonly QuestionBlock[], drafts: Readonly<Record<string, BlockDraft>>): BlockAnswer[] {
  return blocks.map((block) => {
    const draft = drafts[block.commentId] ?? EMPTY_DRAFT;
    if (block.format === "raw") return { blockId: block.commentId, revision: block.revision, answers: [], text: draft.raw };
    return {
      blockId: block.commentId,
      revision: block.revision,
      answers: block.questions
        .filter((question) => hasAnswer(draft, question.number))
        .map((question) => ({
          number: question.number,
          option: draft.options[question.number] ?? null,
          text: draft.texts[question.number] ?? "",
        })),
    };
  });
}

export function answerProgress(blocks: readonly QuestionBlock[], drafts: Readonly<Record<string, BlockDraft>>): { answered: number; total: number } {
  let answered = 0;
  let total = 0;
  for (const block of blocks) {
    const draft = drafts[block.commentId] ?? EMPTY_DRAFT;
    if (block.format === "raw") {
      total += 1;
      if (draft.raw.trim() !== "") answered += 1;
      continue;
    }
    for (const question of block.questions) {
      total += 1;
      if (hasAnswer(draft, question.number)) answered += 1;
    }
  }
  return { answered, total };
}

export interface BlockNotice {
  blockId: string;
  issueIdentifier: string;
  questionCount: number;
  preview: string;
}

/** One notification for every block claimed together. */
export function announcement(notes: readonly BlockNotice[]): { title: string; body: string } {
  const first = notes[0];
  if (first === undefined) return { title: "", body: "" };
  if (notes.length === 1) {
    const more = first.questionCount > 1 ? ` (+${first.questionCount - 1} more)` : "";
    return { title: `Steward question on ${first.issueIdentifier}`, body: `${first.preview}${more}` };
  }
  return {
    title: `${notes.length} new steward question blocks`,
    body: notes.map((note) => `${note.issueIdentifier}: ${note.preview}`).join("\n"),
  };
}
