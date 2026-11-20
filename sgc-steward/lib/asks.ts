// Questions agents ask through `bb sgc ask` instead of a bb question dialog.
//
// Pure helpers: checks for what an agent sends, and the exact text of what the
// plugin sends back. The owner's words are quoted as typed, and every record
// posted to Linear, of an answer or of a withdrawal, starts with the record
// header, so it closes no block.

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { RECORD_HEADER } from "./questions.ts";

export const ASK_LIMITS = {
  questionChars: 4000,
  /** The Charter's limits: a question is short, and so is each option. */
  questionWords: 80,
  optionChars: 500,
  optionWords: 25,
  /** Options the asker offers; the Pause option is added to them. */
  options: 3,
  /** Open questions one thread may have waiting. */
  openPerThread: 10,
  /** Open questions in all, which bounds `bb sgc questions` output. */
  openTotal: 50,
  /** A withdrawal reason, which goes to the asker and the issue record. */
  reasonChars: 2000,
  /** Labels on one question, and the length of each. A label names the issue's Linear project. */
  labels: 1,
  labelChars: 80,
} as const;

/** The first words of every message the plugin sends to a thread. */
export const DELIVERY_PREFIX = "[sgc-steward]";

export interface AskOption {
  letter: string;
  text: string;
  recommended: boolean;
}

export interface Ask {
  /** Like bbq_k3x9mz2p4q. */
  id: string;
  /** The asking thread, which receives the answer. */
  threadId: string;
  threadTitle: string;
  question: string;
  options: AskOption[];
  /** A Linear issue identifier, like TEAM-12, that gets a record of the answer. */
  issue: string | null;
  /** Names to sort and filter questions by, as the asker spelled them. Kept from the first ask. */
  labels: string[];
  askedAt: number;
}

/**
 * Where the owner's answer reached the store: "bb" is the plugin's answer
 * RPC, which the page calls; "linear" is reserved for an answer taken from a
 * Linear comment, which no path takes today.
 */
export type AnswerChannel = "bb" | "linear";

export interface AskAnswer {
  /** The picked option's letter, or null for a typed answer. */
  option: string | null;
  /** A typed answer, or a note under the picked option. */
  text: string;
}

const ISSUE_REF = /^[A-Z0-9]{1,16}-\d{1,9}$/;
const THREAD_ID = /^thr_[a-z0-9]+$/;

export function checkQuestion(text: string): string {
  const question = text.trim();
  if (question === "") throw new Error("the question is empty");
  if (question.length > ASK_LIMITS.questionChars) throw new Error(`the question is over ${ASK_LIMITS.questionChars} characters`);
  const count = wordCount(question);
  if (count > ASK_LIMITS.questionWords) throw new Error(`the question is ${count} words; it takes at most ${ASK_LIMITS.questionWords} words`);
  return question;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/** The last option of every question. It is never recommended and counts against no limit. */
export const PAUSE_OPTION = "Pause it: stop this work for now, and resume it later.";

/**
 * Options lettered A, B, and so on, in order, then the Pause option; `recommend`
 * names one of the asker's letters or none.
 */
export function askOptions(texts: readonly string[], recommend: string | null): AskOption[] {
  if (texts.length > ASK_LIMITS.options) throw new Error(`a question takes at most ${ASK_LIMITS.options} options`);
  const options = texts.map((raw, index) => {
    const letter = String.fromCharCode(65 + index);
    const text = raw.trim();
    if (text === "") throw new Error(`option ${letter} is empty`);
    if (text.length > ASK_LIMITS.optionChars) throw new Error(`option ${letter} is over ${ASK_LIMITS.optionChars} characters`);
    if (wordCount(text) > ASK_LIMITS.optionWords) throw new Error(`option ${letter} is over ${ASK_LIMITS.optionWords} words`);
    return { letter, text, recommended: letter === recommend };
  });
  if (recommend !== null && !options.some((option) => option.letter === recommend)) {
    throw new Error(`there is no option ${recommend} to recommend`);
  }
  return [...options, { letter: String.fromCharCode(65 + options.length), text: PAUSE_OPTION, recommended: false }];
}

// The question's Markdown is parsed as bb's page parses it: GFM (remark-gfm
// uses these same packages) and math blocks (bb's remark-math, with single
// dollars left as text). A table the page draws becomes a `table` node, so
// only pipe rows the parser left as paragraph text can be a broken table.
// An earlier line scanner drifted from GFM on escapes, fences, code spans
// and HTML; the parser is the one source of truth.
const PARSE_OPTIONS = {
  extensions: [gfm(), math({ singleDollarTextMath: false })],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
};

/** A line written as a table row: it starts and ends with `|`. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** Offsets of each line's start, so a line can be matched to node positions. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

/**
 * The 1-based lines that start a table bb's Markdown will not draw: two or
 * more lines in a row, inside one paragraph, that start and end with `|`.
 * The page shows them as plain text, usually because no delimiter row
 * (`| --- | --- |`, one cell per column) sits right under the header row.
 * A line counts only when its first and last pipes sit in visible text: not
 * in inline code or math, not in a link's title, and not between an inline
 * `<pre>` or `<code>` tag and its end, where bb's HTML renderer keeps the
 * rows literal. Code blocks, HTML blocks, math blocks and drawn tables are
 * never paragraphs. Only the explicit `| a | b |` shape counts, so text that
 * merely holds pipes raises nothing.
 */
export function brokenTables(text: string): number[] {
  const tree = fromMarkdown(text, PARSE_OPTIONS);
  const lines = text.split(/\r\n?|\n/);
  const starts = lineStarts(text);
  const broken: number[] = [];

  type Range = [number, number];
  const within = (ranges: Range[], offset: number) => ranges.some(([from, to]) => offset >= from && offset < to);

  /** Offset ranges of the visible text under a paragraph, and its inline HTML in order. */
  function collect(node: Nodes, texts: Range[], html: Array<{ value: string; from: number; to: number }>): void {
    if (node.position) {
      const from = node.position.start.offset ?? 0;
      const to = node.position.end.offset ?? 0;
      if (node.type === "text") texts.push([from, to]);
      if (node.type === "html") html.push({ value: node.value, from, to });
    }
    if ("children" in node) for (const child of node.children) collect(child, texts, html);
  }

  /** Spans from an inline `<pre>` or `<code>` to its end tag, or to the paragraph's end. */
  function literalSpans(html: Array<{ value: string; from: number; to: number }>, end: number): Range[] {
    const spans: Range[] = [];
    let open: { tag: string; from: number } | null = null;
    for (const node of html) {
      if (open === null) {
        const tag = /^<(pre|code)\b/i.exec(node.value)?.[1]?.toLowerCase();
        if (tag !== undefined) open = { tag, from: node.from };
      } else if (new RegExp(`^</${open.tag}\\s*>`, "i").test(node.value)) {
        spans.push([open.from, node.to]);
        open = null;
      }
    }
    if (open !== null) spans.push([open.from, end]);
    return spans;
  }

  function isTextRow(line: number, texts: Range[], literal: Range[]): boolean {
    const source = lines[line - 1] ?? "";
    if (!TABLE_ROW.test(source)) return false;
    const pipes = [starts[line - 1]! + source.indexOf("|"), starts[line - 1]! + source.lastIndexOf("|")];
    return pipes.every((offset) => within(texts, offset) && !within(literal, offset));
  }

  function walk(node: Nodes): void {
    if (node.type === "paragraph" && node.position) {
      const texts: Range[] = [];
      const html: Array<{ value: string; from: number; to: number }> = [];
      collect(node, texts, html);
      const literal = literalSpans(html, node.position.end.offset ?? text.length);
      let run = 0;
      for (let line = node.position.start.line; line <= node.position.end.line + 1; line += 1) {
        if (line <= node.position.end.line && isTextRow(line, texts, literal)) {
          run += 1;
          continue;
        }
        if (run >= 2) broken.push(line - run);
        run = 0;
      }
      return;
    }
    if ("children" in node) for (const child of node.children) walk(child);
  }

  walk(tree);
  return broken;
}

/**
 * One line for `bb sgc ask` that names the question and each option holding a
 * table the page will show as plain text, or null when there is none. The
 * question is stored as written either way: the check only warns.
 */
export function tableWarning(question: string, options: readonly string[]): string | null {
  const where = (name: string, lines: number[]) => `${name} (line${lines.length === 1 ? "" : "s"} ${lines.join(", ")})`;
  const places: string[] = [];
  const inQuestion = brokenTables(question);
  if (inQuestion.length > 0) places.push(where("the question", inQuestion));
  options.forEach((text, index) => {
    const lines = brokenTables(text);
    if (lines.length > 0) places.push(where(`option ${String.fromCharCode(65 + index)}`, lines));
  });
  if (places.length === 0) return null;
  return `Warning: a table in ${places.join(" and ")} has no delimiter row, such as | --- | --- |, right under its header row, with one cell per column, so the page will show it as plain text. The question is stored as written; to fix it, withdraw it and ask again.`;
}

/**
 * The one label of a question: the name of one of the team's open Linear
 * projects, in any case, kept as the asker spelled it. `projects` is the last
 * good list of those names, or null before any poll has read it; then any
 * label is taken (see `labelWarning`). A label prints on its own in the CLI,
 * so it must hold no line break or other control character.
 */
export function checkLabels(raw: readonly string[], projects: readonly string[] | null): string[] {
  if (raw.length !== ASK_LIMITS.labels) throw new Error(`a question takes exactly ${ASK_LIMITS.labels} label, the name of its Linear project; got ${raw.length}`);
  const label = raw[0]!.trim();
  if (label === "") throw new Error("the label is empty");
  if (label.length > ASK_LIMITS.labelChars) throw new Error(`label ${label.slice(0, ASK_LIMITS.labelChars)}… is over ${ASK_LIMITS.labelChars} characters`);
  if (/\p{Cc}/u.test(label)) throw new Error(`label ${JSON.stringify(label)} holds a control character`);
  if (projects !== null && !projects.some((name) => name.toLowerCase() === label.toLowerCase())) {
    const shown = projects.slice(0, 15).join("; ");
    throw new Error(`label ${label} is not the name of an open Linear project${projects.length === 0 ? "" : `; the open projects are: ${shown}${projects.length > 15 ? "; …" : ""}`}`);
  }
  return [label];
}

/** A warning for `bb sgc ask` when the label could not be checked against Linear's projects yet, else null. */
export function labelWarning(projects: readonly string[] | null): string | null {
  return projects === null
    ? "Warning: the label was not checked against the open Linear projects, because the plugin has not read them yet. Use the short name of the issue's project."
    : null;
}

export function checkReason(text: string): string {
  const reason = text.trim();
  if (reason === "") throw new Error("the reason is empty");
  if (reason.length > ASK_LIMITS.reasonChars) throw new Error(`the reason is over ${ASK_LIMITS.reasonChars} characters`);
  return reason;
}

export function checkIssueRef(ref: string): string {
  if (!ISSUE_REF.test(ref)) throw new Error(`${ref} is not an issue identifier like TEAM-12`);
  return ref;
}

export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value);
}

export function formatUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function optionLines(ask: Ask): string[] {
  return ask.options.map((option) => `- ${option.letter}${option.recommended ? " (recommended)" : ""}: ${option.text}`);
}

/** The owner's answer as typed: the picked option, then the typed text. Throws when it says nothing or names no option. */
export function answerText(ask: Ask, answer: AskAnswer): string {
  const note = answer.text.trim();
  if (answer.option === null) {
    if (note === "") throw new Error("the answer is empty");
    return note;
  }
  const option = ask.options.find((candidate) => candidate.letter === answer.option);
  if (option === undefined) throw new Error(`there is no option ${answer.option}`);
  const picked = `${option.letter}: ${option.text}`;
  return note === "" ? picked : `${picked}\n${note}`;
}

/** The message sent to the asking thread. */
export function askDelivery(ask: Ask, answer: AskAnswer): string {
  const options = ask.options.length === 0 ? [] : ["", "Options:", ...optionLines(ask)];
  return [
    `${DELIVERY_PREFIX} Answer to ${ask.id}`,
    "",
    `Your question, asked ${formatUtc(ask.askedAt)}:`,
    ask.question,
    ...options,
    "",
    "The owner's answer:",
    answerText(ask, answer),
  ].join("\n");
}

/** The comment that records the question and its answer on the named Linear issue. */
export function askRecord(ask: Ask, answer: AskAnswer): string {
  const options = ask.options.length === 0 ? [] : ["", "Options:", ...optionLines(ask)];
  return [
    `${RECORD_HEADER} ${ask.id} from thread ${ask.threadId} (asked ${formatUtc(ask.askedAt)})`,
    "",
    "Question:",
    ask.question,
    ...options,
    "",
    "Answer:",
    answerText(ask, answer),
  ].join("\n");
}

/** The message sent to the thread that signed a Linear question block. */
export function blockDelivery(issueIdentifier: string, commentId: string, body: string): string {
  return [`${DELIVERY_PREFIX} Answer to your questions on ${issueIdentifier}, posted as Linear comment ${commentId}`, "", body].join("\n");
}

/** The message that tells the asking thread the steward withdrew its question, so it stops waiting. */
export function withdrawalNotice(ask: Ask, steward: string, reason: string): string {
  return [
    `${DELIVERY_PREFIX} Withdrawn ${ask.id}`,
    "",
    `The steward, thread ${steward}, withdrew your question asked ${formatUtc(ask.askedAt)}. It will get no answer, so stop waiting for one.`,
    "",
    "Reason:",
    reason,
    "",
    "Your question:",
    ask.question,
  ].join("\n");
}

/** The comment that records a withdrawal on the question's issue. It starts with the record header, so it closes no block. */
export function withdrawalRecord(ask: Ask, steward: string, reason: string, at: number): string {
  const options = ask.options.length === 0 ? [] : ["", "Options:", ...optionLines(ask)];
  return [
    `${RECORD_HEADER} ${ask.id} from thread ${ask.threadId} (asked ${formatUtc(ask.askedAt)}): withdrawn`,
    "",
    "Question:",
    ask.question,
    ...options,
    "",
    `Withdrawn by the steward, thread ${steward}, at ${formatUtc(at)}. Reason:`,
    reason,
  ].join("\n");
}

/**
 * What goes out when the steward withdraws another thread's question: the
 * notice for the asker, when it can still take one, and the record for the
 * question's issue, when it names one.
 */
export function withdrawalFollowUps(ask: Ask, steward: string, reason: string, tell: boolean, at: number) {
  return {
    notice: tell ? withdrawalNotice(ask, steward, reason) : null,
    record: ask.issue === null ? null : { issue: ask.issue, body: withdrawalRecord(ask, steward, reason, at) },
  };
}
