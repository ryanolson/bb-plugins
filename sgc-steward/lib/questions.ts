// The question format, and when a question counts as answered.
//
// Pure functions over Linear comments, shared by the server, the CLI, and the
// panel. The README documents the format for the agents that write it.
//
// A signed comment starts with `[agent:<tool> <thread id>]`. Every agent posts
// through the owner's Linear login, so the signature is the only thing that
// tells an agent's comment from the owner's. An unsigned comment from a user is
// the owner's answer. Comments from integrations (user null or a bot actor)
// are neither.

import { createHash } from "node:crypto";

/** A Linear comment, reduced to what the rules need. */
export interface LinearComment {
  id: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
  /** "bot" for integration and app comments, which never ask or answer. */
  author: "user" | "bot";
  /** Set on replies in a comment thread; replies follow the same rules. */
  parentId: string | null;
}

export type IssueKind = "checkin" | "needs-decision";

export interface Signature {
  agent: string;
  threadId: string | null;
  /** The rest of the first line after the closing bracket. */
  rest: string;
}

export interface QuestionOption {
  letter: string;
  text: string;
  recommended: boolean;
}

export interface Question {
  number: number;
  text: string;
  /** Recommended option first, the rest in letter order. */
  options: QuestionOption[];
}

interface BlockBase {
  /** The Linear comment id; it also identifies the block. */
  commentId: string;
  /**
   * Hash of what an answer refers to and where it goes: the parsed context,
   * questions, and options, with the thread in the signature, or the whole
   * text of a raw block. The context can name what a question is about, and
   * the thread receives the answer, so both count. An edit to any of them
   * changes the revision, so an answer drafted against the old text is
   * refused instead of read differently or sent elsewhere.
   */
  revision: string;
  createdAt: string;
  agent: string;
  threadId: string | null;
  /** YYYY-MM-DD from a `Questions` header, if there is one. */
  date: string | null;
  /** The whole comment body, as posted. */
  body: string;
}

export type QuestionBlock =
  | (BlockBase & { format: "parsed"; context: string; questions: Question[] })
  | (BlockBase & { format: "raw"; problem: string });

const SIGNATURE = /^\[agent:([^\s\]]+)(?:[ \t]+([^\s\]]+))?[ \t]*\]/;
const HEADER = /^\s*Questions(?:\s+(\d{4}-\d{2}-\d{2}))?\s*$/i;
// Leading whitespace is allowed: Linear stores comments as rich text and can
// write a line that sat right under a list item back indented inside it.
const QUESTION_LINE = /^\s*Q(\d+)\.\s+(.*)$/;
const ANY_QUESTION_LINE = /^\s*Q\d+\.\s/;
const OPTION_LINE = /^\s*[-*+]\s+([A-Z])(?:\s*\(([^)]*)\))?:\s*(.*)$/;

export function parseSignature(body: string): Signature | null {
  const text = body.trimStart();
  const match = SIGNATURE.exec(text);
  if (match === null) return null;
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  return {
    agent: match[1]!,
    threadId: match[2] ?? null,
    rest: firstLine.slice(match[0].length).replace(/\r$/, ""),
  };
}

export function commentRole(comment: Pick<LinearComment, "body" | "author">): "signed" | "answer" | "ignored" {
  if (comment.author === "bot") return "ignored";
  return parseSignature(comment.body) === null ? "answer" : "signed";
}

/**
 * Read one signed comment as a question block, or return null when it is not
 * one. On a check-in issue a block needs `Q<n>.` lines or a bare `Questions`
 * header, so run reports and digests with `1.` lists stay out. On a
 * needs-decision issue the latest signed comment is the question whatever its
 * shape. Anything that does not parse cleanly comes back raw, with the reason,
 * so nothing is hidden.
 */
export function parseQuestionBlock(comment: LinearComment, kind: IssueKind): QuestionBlock | null {
  if (comment.author === "bot") return null;
  const signature = parseSignature(comment.body);
  if (signature === null) return null;
  const header = HEADER.exec(signature.rest);
  const body = comment.body.replace(/\r\n?/g, "\n").trimStart();
  const firstLine = header === null ? signature.rest.trim() : "";
  const lines = [firstLine, ...body.split("\n").slice(1)];
  if (kind === "checkin" && header === null && !lines.some((line) => ANY_QUESTION_LINE.test(line))) return null;

  const result = parseQuestions(lines);
  const base: BlockBase = {
    commentId: comment.id,
    revision: revisionOf(
      "problem" in result ? { format: "raw", body } : { format: "parsed", threadId: signature.threadId, context: result.context, questions: result.questions },
    ),
    createdAt: comment.createdAt,
    agent: signature.agent,
    threadId: signature.threadId,
    date: header?.[1] ?? null,
    body: comment.body,
  };
  return "problem" in result ? { ...base, format: "raw", problem: result.problem } : { ...base, format: "parsed", ...result };
}

function revisionOf(
  content: { format: "raw"; body: string } | { format: "parsed"; threadId: string | null; context: string; questions: Question[] },
): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12);
}

function parseQuestions(lines: string[]): { context: string; questions: Question[] } | { problem: string } {
  const context: string[] = [];
  const questions: Array<{ number: number; text: string[]; options: Array<{ letter: string; text: string[]; recommended: boolean }> }> = [];
  for (const line of lines) {
    const question = QUESTION_LINE.exec(line);
    const current = questions.at(-1);
    if (question !== null) {
      const expected = questions.length + 1;
      if (Number(question[1]) !== expected) return { problem: `expected Q${expected} but found Q${question[1]}` };
      questions.push({ number: expected, text: [question[2]!.trim()], options: [] });
      continue;
    }
    if (current === undefined) {
      context.push(line.trimEnd());
      continue;
    }
    const option = OPTION_LINE.exec(line);
    if (option !== null) {
      const letter = option[1]!;
      const expected = String.fromCharCode(65 + current.options.length);
      if (letter !== expected) return { problem: `Q${current.number}: expected option ${expected} but found ${letter}` };
      const marker = option[2];
      if (marker !== undefined && marker.trim().toLowerCase() !== "recommended") {
        return { problem: `Q${current.number} option ${letter}: (${marker}) is not (recommended)` };
      }
      current.options.push({ letter, text: [option[3]!.trim()], recommended: marker !== undefined });
      continue;
    }
    if (line.trim() === "") continue;
    // An indented line continues the option above it; any other line
    // continues the question.
    const lastOption = current.options.at(-1);
    if (lastOption !== undefined && /^\s/.test(line)) lastOption.text.push(line.trim());
    else current.text.push(line.trim());
  }
  if (questions.length === 0) return { problem: "no Q1. line" };
  for (const question of questions) {
    if (question.text.join("") === "") return { problem: `Q${question.number} has no text` };
    for (const option of question.options) {
      if (option.text.join("") === "") return { problem: `Q${question.number} option ${option.letter} has no text` };
    }
    if (question.options.filter((option) => option.recommended).length > 1) {
      return { problem: `Q${question.number} recommends more than one option` };
    }
  }
  return {
    context: context.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    questions: questions.map((question) => ({
      number: question.number,
      text: question.text.filter((part) => part !== "").join("\n"),
      options: question.options
        .map((option) => ({ letter: option.letter, text: option.text.join("\n"), recommended: option.recommended }))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended)),
    })),
  };
}

function byCreatedAt(a: LinearComment, b: LinearComment): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
}

/** One block at one revision, as an answer names it. */
export interface BlockRef {
  blockId: string;
  revision: string;
}

const ANSWER_HEADER = /^\s*Answers? to the questions? of /;
const BLOCK_REFERENCE = /\(block ([^\s)]+) rev ([0-9a-f]{12})\)/g;
/** The first words of the record of an answered or withdrawn bb question. */
export const RECORD_HEADER = "Answer to bb question";
/** The first line of the comment that marks a todo done. */
export const TODO_DONE_HEADER = "Done (from the SGC page)";
/** The first line of the comment that reopens a todo marked done by mistake. */
export const TODO_REOPENED_HEADER = "Reopened (from the SGC page)";

/**
 * The blocks a plugin answer names in its header lines, or null for a plain
 * answer, which names none and so closes every block before it. The record of
 * a bb question starts with the record header and names no block, whatever
 * else it holds: the question it records can quote an answer header. A
 * comment that marks a todo done or reopened names no block either: it is
 * the owner's comment, but not an answer.
 */
export function answeredBlocks(body: string): BlockRef[] | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = (lines.find((line) => line.trim() !== "") ?? "").trim();
  if (first.startsWith(`${RECORD_HEADER} `) || first === TODO_DONE_HEADER || first === TODO_REOPENED_HEADER) return [];
  const refs: BlockRef[] = [];
  for (const line of lines) {
    if (!ANSWER_HEADER.test(line)) continue;
    for (const match of line.matchAll(BLOCK_REFERENCE)) refs.push({ blockId: match[1]!, revision: match[2]! });
  }
  return refs.length > 0 ? refs : null;
}

/**
 * The question blocks on one issue that still wait for an answer.
 *
 * An answer written by this plugin names the blocks it answers and closes
 * only those, at the revision it names. Any other unsigned comment closes
 * every block before it, as the Charter has it. Naming the blocks keeps a
 * question that lands while an answer is being posted open.
 *
 * Check-in: every question block. needs-decision: only the latest signed
 * comment; the caller checks the label itself.
 */
export function openBlocks(kind: IssueKind, comments: readonly LinearComment[]): QuestionBlock[] {
  let open: QuestionBlock[] = [];
  for (const comment of [...comments].sort(byCreatedAt)) {
    const role = commentRole(comment);
    if (role === "signed") {
      const block = parseQuestionBlock(comment, kind);
      if (kind === "needs-decision") open = block === null ? [] : [block];
      else if (block !== null) open.push(block);
    } else if (role === "answer") {
      const refs = answeredBlocks(comment.body);
      open =
        refs === null
          ? []
          : open.filter((block) => !refs.some((ref) => ref.blockId === block.commentId && ref.revision === block.revision));
    }
  }
  return open;
}

export interface QuestionAnswer {
  number: number;
  /** The picked option's letter, or null for a typed answer. */
  option: string | null;
  /** A typed answer, or a note under the picked option. */
  text: string;
}

export interface BlockAnswer {
  blockId: string;
  /** The revision the answers were written against. */
  revision: string;
  /** Answers by question number, for a parsed block. */
  answers: QuestionAnswer[];
  /** The answer to a raw block. */
  text?: string;
}

function blockDay(block: QuestionBlock): string {
  return block.date ?? block.createdAt.slice(0, 10);
}

function postedAt(block: QuestionBlock): string {
  const iso = new Date(block.createdAt).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The header line that names one block: its date, and the comment id and
 * revision that `answeredBlocks` reads back. `posted` adds the time, which
 * tells apart two blocks of the same day.
 */
export function answerHeader(block: QuestionBlock, posted: boolean): string {
  const noun = block.format === "raw" ? "Answer to the question" : "Answers to the questions";
  const when = posted ? `, posted ${postedAt(block)}` : "";
  return `${noun} of ${blockDay(block)}${when} (block ${block.commentId} rev ${block.revision})`;
}

/**
 * The Linear comment id for an answer, derived from the issue and the whole
 * answer body, which names each block and revision it answers. A write that
 * timed out can still commit later, so every retry and every resubmission of
 * the same answer must reuse its id: Linear then keeps at most one copy.
 * Shaped as a UUID v4, the form Linear accepts for a caller-chosen id.
 */
export function answerCommentId(issueId: string, body: string): string {
  const bytes = createHash("sha256").update(`${issueId}\n${body}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether an answer's block references name exactly the open blocks, at their revisions. */
export function sameBlocks(sent: readonly BlockRef[], open: readonly QuestionBlock[]): boolean {
  const key = (id: string, revision: string) => `${id}@${revision}`;
  const a = sent.map((ref) => key(ref.blockId, ref.revision)).sort();
  const b = open.map((block) => key(block.commentId, block.revision)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The answer an earlier try already posted: the comment with the id this
 * same answer derives, when it is on the issue. Its reply was lost, so
 * the answer is finished instead of refused.
 */
export function postedBefore(
  issueId: string,
  comments: readonly LinearComment[],
  expected: readonly BlockRef[],
  compose: (blocks: QuestionBlock[]) => string,
): { commentId: string; body: string; blocks: QuestionBlock[] } | null {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const blocks: QuestionBlock[] = [];
  for (const ref of expected) {
    const comment = byId.get(ref.blockId);
    // The id and revision pin the block, so any signed comment may be read as one.
    const block = comment === undefined ? null : parseQuestionBlock(comment, "needs-decision");
    if (block === null || block.revision !== ref.revision) return null;
    blocks.push(block);
  }
  blocks.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.commentId.localeCompare(b.commentId));
  let body: string;
  try {
    body = compose(blocks);
  } catch {
    return null;
  }
  const commentId = answerCommentId(issueId, body);
  return byId.has(commentId) ? { commentId, body, blocks } : null;
}

/**
 * A typed answer, as `bb sgc answer` posts it: one header line per block it
 * answers, then the text as written.
 */
export function composeTextAnswer(blocks: readonly QuestionBlock[], text: string): string {
  const body = text.trim();
  if (body === "") throw new Error("the answer is empty");
  return `${blocks.map((block) => answerHeader(block, blocks.length > 1)).join("\n")}\n\n${body}`;
}

/**
 * Write the one unsigned comment that answers every open block on an issue,
 * numbered to match. Each block gets a header that names it, so the answer
 * closes those blocks and no other. The header comes first, so the answer can
 * never read as signed. Throws when the answers do not fit the blocks or say
 * nothing.
 */
export function composeAnswer(blocks: readonly QuestionBlock[], answers: readonly BlockAnswer[]): string {
  const byBlock = new Map<string, BlockAnswer>();
  for (const answer of answers) {
    const block = blocks.find((candidate) => candidate.commentId === answer.blockId);
    if (block === undefined) throw new Error(`block ${answer.blockId} is not open`);
    if (block.revision !== answer.revision) throw new Error(`block ${answer.blockId} changed after the answers were written`);
    byBlock.set(answer.blockId, answer);
  }
  const missing = blocks.filter((block) => !byBlock.has(block.commentId)).map((block) => block.commentId);
  if (missing.length > 0) throw new Error(`missing answers for block ${missing.join(", ")}`);

  let said = false;
  const sections = blocks.map((block) => {
    const answer = byBlock.get(block.commentId)!;
    const header = answerHeader(block, blocks.length > 1);
    if (block.format === "raw") {
      if (answer.answers.length > 0) throw new Error(`block ${block.commentId} is not in the question format; answer it with text`);
      const text = answer.text?.trim() ?? "";
      if (text !== "") said = true;
      return `${header}\n\n${text === "" ? "No answer." : text}`;
    }
    const byNumber = new Map<number, QuestionAnswer>();
    for (const item of answer.answers) {
      const question = block.questions.find((candidate) => candidate.number === item.number);
      if (question === undefined) throw new Error(`Q${item.number} is not a question in block ${block.commentId}`);
      if (byNumber.has(item.number)) throw new Error(`Q${item.number} is answered twice`);
      if (item.option !== null && !question.options.some((option) => option.letter === item.option)) {
        throw new Error(`Q${item.number} has no option ${item.option}`);
      }
      byNumber.set(item.number, item);
    }
    const lines = block.questions.map((question) => {
      const item = byNumber.get(question.number);
      const note = item?.text.trim() ?? "";
      const option = question.options.find((candidate) => candidate.letter === item?.option);
      if (option === undefined && note === "") return `Q${question.number}. No answer.`;
      said = true;
      if (option === undefined) return `Q${question.number}. ${note}`;
      const picked = `Q${question.number}. ${option.letter}: ${option.text.replace(/\n/g, " ")}`;
      return note === "" ? picked : `${picked}\n${note}`;
    });
    return [header, ...lines].join("\n\n");
  });
  if (!said) throw new Error("nothing to post: every answer is empty");
  return sections.join("\n\n");
}
