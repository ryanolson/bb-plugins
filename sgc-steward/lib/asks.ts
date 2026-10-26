// Questions agents ask through `bb sgc ask` instead of a bb question dialog.
//
// Pure helpers: checks for what an agent sends, and the exact text of what the
// plugin sends back. The owner's words are quoted as typed, and every record
// posted to Linear, of an answer or of a withdrawal, starts with the record
// header, so it closes no block.

import { RECORD_HEADER } from "./questions.ts";

export const ASK_LIMITS = {
  questionChars: 4000,
  optionChars: 500,
  options: 10,
  /** Open questions one thread may have waiting. */
  openPerThread: 10,
  /** Open questions in all, which bounds `bb sgc questions` output. */
  openTotal: 50,
  /** A withdrawal reason, which goes to the asker and the issue record. */
  reasonChars: 2000,
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
  askedAt: number;
}

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
  return question;
}

/** Options lettered A, B, and so on, in order; `recommend` names one letter or none. */
export function askOptions(texts: readonly string[], recommend: string | null): AskOption[] {
  if (texts.length > ASK_LIMITS.options) throw new Error(`a question takes at most ${ASK_LIMITS.options} options`);
  const options = texts.map((raw, index) => {
    const letter = String.fromCharCode(65 + index);
    const text = raw.trim();
    if (text === "") throw new Error(`option ${letter} is empty`);
    if (text.length > ASK_LIMITS.optionChars) throw new Error(`option ${letter} is over ${ASK_LIMITS.optionChars} characters`);
    return { letter, text, recommended: letter === recommend };
  });
  if (recommend !== null && !options.some((option) => option.letter === recommend)) {
    throw new Error(`there is no option ${recommend} to recommend`);
  }
  return options;
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
