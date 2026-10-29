// The pure logic behind the Questions page and the notifier, kept out of the
// React code so it can be tested without a DOM.

import type { DeliveryView, Panel } from "./contract.ts";
import type { BlockAnswer, Question, QuestionBlock } from "./questions.ts";

/** A new question to announce: a Linear block, labeled by its issue, or a bb question, labeled by its thread. */
export interface Notice {
  id: string;
  source: "linear" | "ask" | "todo";
  label: string;
  questionCount: number;
  preview: string;
}

/** One notification for every question claimed together. */
export function announcement(notes: readonly Notice[]): { title: string; body: string } {
  const first = notes[0];
  if (first === undefined) return { title: "", body: "" };
  if (notes.length === 1) {
    if (first.source === "todo") return { title: `New todo: ${first.label}`, body: first.preview };
    const more = first.questionCount > 1 ? ` (+${first.questionCount - 1} more)` : "";
    const title = first.source === "linear" ? `Steward question on ${first.label}` : `Question from ${first.label}`;
    return { title, body: `${first.preview}${more}` };
  }
  const todos = notes.filter((note) => note.source === "todo").length;
  const questions = notes.length - todos;
  const counted = (count: number, noun: string) => (count === 0 ? [] : [`${count} new ${noun}${count === 1 ? "" : "s"}`]);
  return {
    title: [...counted(questions, "question"), ...counted(todos, "todo")].join(" and "),
    body: notes.map((note) => `${note.label}: ${note.preview}`).join("\n"),
  };
}

type ParsedBlock = Extract<QuestionBlock, { format: "parsed" }>;
type RawBlock = Extract<QuestionBlock, { format: "raw" }>;

/**
 * A card on the page, each answered on its own: one open question of a
 * Linear block, a Linear block not in the question format, or an open bb
 * question.
 */
export type Card<I, A> =
  | { kind: "question"; at: number; issue: I; block: ParsedBlock; question: Question }
  | { kind: "raw"; at: number; issue: I; block: RawBlock }
  | { kind: "ask"; at: number; ask: A };

/** Every open question its own card, with the bb questions, oldest first; a block's questions in their order. */
export function orderCards<I extends { blocks: readonly QuestionBlock[] }, A extends { askedAt: number }>(issues: readonly I[], asks: readonly A[]): Array<Card<I, A>> {
  const cards: Array<Card<I, A>> = [];
  for (const issue of issues) {
    for (const block of issue.blocks) {
      const at = Date.parse(block.createdAt);
      if (block.format === "raw") cards.push({ kind: "raw", at, issue, block });
      else for (const question of block.questions) cards.push({ kind: "question", at, issue, block, question });
    }
  }
  for (const ask of asks) cards.push({ kind: "ask", at: ask.askedAt, ask });
  // A stable sort keeps a block's questions in their order.
  return cards.sort((a, b) => a.at - b.at);
}

/** What the owner picked or typed for one bb question. */
export interface AskDraft {
  option: string | null;
  text: string;
}

/**
 * The `questions.answer` input for one card: one question of a block, or a
 * block not in the question format (`question` null). Null when the draft
 * says nothing yet. The revision is the one the card shows.
 */
export function questionAnswerInput(
  issueId: string,
  block: QuestionBlock,
  question: number | null,
  draft: AskDraft,
): { issueId: string; blocks: BlockAnswer[] } | null {
  if (draft.option === null && draft.text.trim() === "") return null;
  const answer: BlockAnswer =
    question === null
      ? { blockId: block.commentId, revision: block.revision, answers: [], text: draft.text }
      : { blockId: block.commentId, revision: block.revision, answers: [{ number: question, option: draft.option, text: draft.text }] };
  return { issueId, blocks: [answer] };
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

/** Open questions: each question of a parsed Linear block, each block in no format, and each bb question. */
export function openQuestions(view: Pick<BadgeInput, "issues" | "asks">): number {
  const linear = view.issues.reduce(
    (sum, issue) => sum + issue.blocks.reduce((count, block) => count + (block.format === "parsed" ? block.questions.length : 1), 0),
    0,
  );
  return linear + view.asks.length;
}

/** The sidebar badge: open questions first, then answers that did not go out, then Linear trouble. */
export function questionBadge(view: BadgeInput): { count?: number; tone: "warning" | "critical"; label: string } | null {
  const open = openQuestions(view);
  if (open > 0) return { count: open, tone: "warning", label: `${open} open question${open === 1 ? "" : "s"}` };
  const stuck = view.undelivered.length + view.unposted.length;
  if (stuck > 0) return { tone: "critical", label: `${stuck} answer${stuck === 1 ? "" : "s"} did not go out` };
  if (!view.configured) return { tone: "critical", label: "SGC Steward needs a Linear API key" };
  if (view.error !== null) return { tone: "critical", label: "SGC Steward cannot read Linear" };
  return null;
}

/**
 * The page's undoable Dones after a new one. Undo applies to the latest Done
 * of an issue only, so a new Done replaces the entry of an earlier one.
 */
export function withDone<T extends { issueId: string }>(list: readonly T[], entry: T): T[] {
  return [...list.filter((candidate) => candidate.issueId !== entry.issueId), entry];
}

/** The page's tabs, in order, each at its own route under the panel. A later tab, such as Ideas, joins this list. */
export const PANEL_TABS = [
  { id: "questions", label: "Questions", subPath: "" },
  { id: "todos", label: "Todos", subPath: "todos" },
] as const;

export type PanelTab = (typeof PANEL_TABS)[number]["id"];

/** The tab a panel route shows. The root, and a route the page does not know, show Questions. */
export function tabOf(subPath: string): PanelTab {
  const head = subPath.split("/")[0];
  return PANEL_TABS.find((tab) => tab.subPath === head)?.id ?? "questions";
}

/** The route of a tab, for `toPluginPanel`. */
export function tabPath(tab: PanelTab): string {
  return PANEL_TABS.find((candidate) => candidate.id === tab)!.subPath;
}

/** The tab a notification opens: Todos when it tells only of new todos, else Questions. */
export function noticeTab(notes: ReadonlyArray<Pick<Notice, "source">>): PanelTab {
  return notes.length > 0 && notes.every((note) => note.source === "todo") ? "todos" : "questions";
}

/** The tab that lists each kind of send that did not go out. A new kind of send must pick one. */
const SEND_TAB: Record<DeliveryView["source"], PanelTab> = { ask: "questions", linear: "questions", withdrawal: "questions", todo: "todos" };

/** The sends that did not go out which a tab lists: the steward's todo messages on Todos, answers and notices on Questions. */
export function sendsFor<R extends Pick<DeliveryView, "source">>(tab: PanelTab, rows: readonly R[]): R[] {
  return rows.filter((row) => SEND_TAB[row.source] === tab);
}

interface TabInput extends Pick<BadgeInput, "issues" | "asks" | "unposted"> {
  issueErrors: readonly unknown[];
  undelivered: ReadonlyArray<Pick<DeliveryView, "source">>;
  todos: readonly unknown[];
  todoError: string | null;
}

/** A tab's badge: what is open on it, and whether something on it failed, so a failure behind another tab still shows. */
export interface TabBadge {
  count: number;
  alert: boolean;
}

/** Each tab's badge: open questions, or open todos, and an alert for a failed send, record, or read on that tab. */
export function tabBadges(view: TabInput): Record<PanelTab, TabBadge> {
  return {
    questions: { count: openQuestions(view), alert: sendsFor("questions", view.undelivered).length + view.unposted.length + view.issueErrors.length > 0 },
    todos: { count: view.todos.length, alert: sendsFor("todos", view.undelivered).length > 0 || view.todoError !== null },
  };
}

/** Whether a question has every label wanted, in any case. Wanting none matches every question. */
export function hasLabels(labels: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(labels.map((label) => label.toLowerCase()));
  return wanted.every((label) => have.has(label.toLowerCase()));
}

/** A card's labels: a bb question's own, or the labels of a Linear question's issue. */
function cardLabels<I extends { labels: readonly string[] }, A extends { labels: readonly string[] }>(card: Card<I, A>): readonly string[] {
  return card.kind === "ask" ? card.ask.labels : card.issue.labels;
}

/** The cards with every label wanted. */
export function filterCards<I extends { labels: readonly string[] }, A extends { labels: readonly string[] }>(cards: ReadonlyArray<Card<I, A>>, wanted: readonly string[]): Array<Card<I, A>> {
  return cards.filter((card) => hasLabels(cardLabels(card), wanted));
}

export type CardOrder = "age" | "label";

/**
 * The cards in the order chosen: as given, oldest first, or by label, under
 * each card's first label in alphabetical order ignoring case, with cards
 * that have no label last. A stable sort keeps the oldest first among equals.
 */
export function sortCards<I extends { labels: readonly string[] }, A extends { labels: readonly string[] }>(cards: ReadonlyArray<Card<I, A>>, order: CardOrder): Array<Card<I, A>> {
  if (order === "age") return [...cards];
  const first = (card: Card<I, A>) => cardLabels(card).map((label) => label.toLowerCase()).sort()[0] ?? null;
  return [...cards].sort((a, b) => {
    const [x, y] = [first(a), first(b)];
    if (x === y) return 0;
    if (x === null || y === null) return x === null ? 1 : -1;
    return x < y ? -1 : 1;
  });
}

/**
 * The label chips: every label on the open questions, once in its first
 * spelling, alphabetical ignoring case. A chosen label stays, so a filter
 * whose last question was answered can still be cleared.
 */
export function labelChoices(asks: ReadonlyArray<{ labels: readonly string[] }>, chosen: readonly string[]): string[] {
  const choices = new Map<string, string>();
  for (const label of [...asks.flatMap((ask) => ask.labels), ...chosen]) if (!choices.has(label.toLowerCase())) choices.set(label.toLowerCase(), label);
  return [...choices.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

/** What `bb sgc questions --label` lists: the questions with every label named, of both kinds. */
export function filterPanel(view: Panel, wanted: readonly string[]): Panel {
  return wanted.length === 0
    ? view
    : { ...view, issues: view.issues.filter((issue) => hasLabels(issue.labels, wanted)), asks: view.asks.filter((ask) => hasLabels(ask.labels, wanted)) };
}
