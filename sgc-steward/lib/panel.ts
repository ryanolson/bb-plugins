// The pure logic behind the Questions page and the notifier, kept out of the
// React code so it can be tested without a DOM.

import type { BlockAnswer, QuestionBlock } from "./questions.ts";

/** What the user picked or typed for one block, keyed by question number. */
export interface BlockDraft {
  options: Record<number, string>;
  texts: Record<number, string>;
  /** The answer to a block that is not in the question format. */
  raw: string;
  /**
   * The block's revision when the draft was first edited. Sent with the
   * answer, so an edit to the block since then is refused, not answered.
   */
  revision?: string;
}

export const EMPTY_DRAFT: BlockDraft = { options: {}, texts: {}, raw: "" };

function hasAnswer(draft: BlockDraft, number: number): boolean {
  return draft.options[number] !== undefined || (draft.texts[number] ?? "").trim() !== "";
}

/** The answer blocks for `questions.answer`; untouched questions are left out. */
export function toAnswerBlocks(blocks: readonly QuestionBlock[], drafts: Readonly<Record<string, BlockDraft>>): BlockAnswer[] {
  return blocks.map((block) => {
    const draft = drafts[block.commentId] ?? EMPTY_DRAFT;
    const revision = draft.revision ?? block.revision;
    if (block.format === "raw") return { blockId: block.commentId, revision, answers: [], text: draft.raw };
    return {
      blockId: block.commentId,
      revision,
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

/** A new question to announce: a Linear block, labeled by its issue, or a bb question, labeled by its thread. */
export interface Notice {
  id: string;
  source: "linear" | "ask";
  label: string;
  questionCount: number;
  preview: string;
}

/** One notification for every question claimed together. */
export function announcement(notes: readonly Notice[]): { title: string; body: string } {
  const first = notes[0];
  if (first === undefined) return { title: "", body: "" };
  if (notes.length === 1) {
    const more = first.questionCount > 1 ? ` (+${first.questionCount - 1} more)` : "";
    const title = first.source === "linear" ? `Steward question on ${first.label}` : `Question from ${first.label}`;
    return { title, body: `${first.preview}${more}` };
  }
  return { title: `${notes.length} new questions`, body: notes.map((note) => `${note.label}: ${note.preview}`).join("\n") };
}

/** A card on the page: an issue with open Linear blocks, or an open bb question. */
export type Card<I, A> = { kind: "issue"; at: number; issue: I } | { kind: "ask"; at: number; ask: A };

/** Issues and bb questions in one list, oldest first; an issue counts from its oldest open block. */
export function orderCards<I extends { blocks: readonly Pick<QuestionBlock, "createdAt">[] }, A extends { askedAt: number }>(
  issues: readonly I[],
  asks: readonly A[],
): Array<Card<I, A>> {
  const cards: Array<Card<I, A>> = [
    ...issues.map((issue) => ({ kind: "issue" as const, at: Math.min(...issue.blocks.map((block) => Date.parse(block.createdAt))), issue })),
    ...asks.map((ask) => ({ kind: "ask" as const, at: ask.askedAt, ask })),
  ];
  return cards.sort((a, b) => a.at - b.at);
}

/** What the owner picked or typed for one bb question. */
export interface AskDraft {
  option: string | null;
  text: string;
}

/** The `asks.answer` input, or null when the draft says nothing yet. */
export function askAnswerInput(id: string, draft: AskDraft): { id: string; option: string | null; text: string } | null {
  if (draft.option === null && draft.text.trim() === "") return null;
  return { id, option: draft.option, text: draft.text };
}

interface BadgeInput {
  configured: boolean;
  error: string | null;
  issues: ReadonlyArray<{ blocks: readonly QuestionBlock[] }>;
  asks: readonly unknown[];
  undelivered: readonly unknown[];
  unposted: readonly unknown[];
}

/** The sidebar badge: open questions first, then answers that did not go out, then Linear trouble. */
export function questionBadge(view: BadgeInput): { count?: number; tone: "warning" | "critical"; label: string } | null {
  const linear = view.issues.reduce(
    (sum, issue) => sum + issue.blocks.reduce((count, block) => count + (block.format === "parsed" ? block.questions.length : 1), 0),
    0,
  );
  const open = linear + view.asks.length;
  if (open > 0) return { count: open, tone: "warning", label: `${open} open question${open === 1 ? "" : "s"}` };
  const stuck = view.undelivered.length + view.unposted.length;
  if (stuck > 0) return { tone: "critical", label: `${stuck} answer${stuck === 1 ? "" : "s"} did not go out` };
  if (!view.configured) return { tone: "critical", label: "SGC Steward needs a Linear API key" };
  if (view.error !== null) return { tone: "critical", label: "SGC Steward cannot read Linear" };
  return null;
}
