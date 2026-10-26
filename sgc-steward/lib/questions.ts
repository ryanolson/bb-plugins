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
   * Hash of what an answer refers to: the parsed questions and options, or the
   * whole text of a raw block. An edit that changes them changes it, so an
   * answer drafted against the old text is refused.
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
    revision: revisionOf("problem" in result ? { format: "raw", body } : { format: "parsed", questions: result.questions }),
    createdAt: comment.createdAt,
    agent: signature.agent,
    threadId: signature.threadId,
    date: header?.[1] ?? null,
    body: comment.body,
  };
  return "problem" in result ? { ...base, format: "raw", problem: result.problem } : { ...base, format: "parsed", ...result };
}

function revisionOf(content: { format: "raw"; body: string } | { format: "parsed"; questions: Question[] }): string {
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

/**
 * The question blocks on one issue that still wait for an answer.
 *
 * Check-in: every question block posted after the latest unsigned comment.
 * One answer therefore closes every block before it, which is why the panel
 * answers all open blocks of an issue in one comment.
 *
 * needs-decision: the latest signed comment, unless an unsigned comment came
 * after it. The caller checks the label itself.
 */
export function openBlocks(kind: IssueKind, comments: readonly LinearComment[]): QuestionBlock[] {
  const sorted = [...comments].sort(byCreatedAt);
  let lastAnswer = -1;
  sorted.forEach((comment, index) => {
    if (commentRole(comment) === "answer") lastAnswer = index;
  });
  const after = sorted.slice(lastAnswer + 1);
  if (kind === "checkin") {
    return after.flatMap((comment) => parseQuestionBlock(comment, "checkin") ?? []);
  }
  const latest = after.filter((comment) => commentRole(comment) === "signed").at(-1);
  const block = latest === undefined ? null : parseQuestionBlock(latest, "needs-decision");
  return block === null ? [] : [block];
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
 * Write the one unsigned comment that answers every open block on an issue,
 * numbered to match. It starts with a plain header, so it can never read as
 * signed. Throws when the answers do not fit the blocks or say nothing.
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
    const when = blocks.length > 1 ? ` (posted ${postedAt(block)})` : "";
    if (block.format === "raw") {
      if (answer.answers.length > 0) throw new Error(`block ${block.commentId} is not in the question format; answer it with text`);
      const text = answer.text?.trim() ?? "";
      if (text !== "") said = true;
      return `Answer to the question of ${blockDay(block)}${when}\n\n${text === "" ? "No answer." : text}`;
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
    return [`Answers to the questions of ${blockDay(block)}${when}`, ...lines].join("\n\n");
  });
  if (!said) throw new Error("nothing to post: every answer is empty");
  return sections.join("\n\n");
}
