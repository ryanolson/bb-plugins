// The owner's todo list: open issues that wait on something only the owner
// can do. Pure helpers: which issues are todos, their checklist steps, and
// the text that marking one done, or reopening it, posts and sends.

import { DELIVERY_PREFIX } from "./asks.ts";
import { HUMAN_LABEL, TODO_LABEL, type TodoIssue } from "./linear.ts";
import { TODO_DONE_HEADER, TODO_REOPENED_HEADER } from "./questions.ts";

export const TODO_NOTE_CHARS = 2000;

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export function hasLabel(issue: Pick<TodoIssue, "labels">, name: string): boolean {
  return issue.labels.some((label) => label.name === name);
}

/**
 * On the owner's todo list: open, and either waiting on the owner's action or
 * the owner's own human issue. An issue waiting on the owner's decision is a
 * question, not a todo.
 */
export function isTodo(issue: TodoIssue): boolean {
  if (issue.state?.type === "completed" || issue.state?.type === "canceled") return false;
  return hasLabel(issue, TODO_LABEL) || (hasLabel(issue, HUMAN_LABEL) && issue.assignedToMe);
}

const TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;

/** The task lines of a Markdown description, `- [ ] step` or `- [x] step`, in order. */
export function checklist(description: string): ChecklistItem[] {
  return description.split(/\r?\n/).flatMap((line) => {
    const task = TASK_LINE.exec(line);
    return task === null ? [] : [{ text: task[2]!, done: task[1] !== " " }];
  });
}

/** A note for Done, trimmed; null when it says nothing. Throws when it is too long. */
export function checkNote(text: string): string | null {
  const note = text.trim();
  if (note.length > TODO_NOTE_CHARS) throw new Error(`the note is over ${TODO_NOTE_CHARS} characters`);
  return note === "" ? null : note;
}

/** The owner's comment that marks a todo done. Its first line names no question block. */
export function doneComment(note: string | null): string {
  return note === null ? TODO_DONE_HEADER : `${TODO_DONE_HEADER}\n\n${note}`;
}

/** The owner's comment that reopens a todo marked done by mistake. */
export function reopenedComment(): string {
  return TODO_REOPENED_HEADER;
}

/** The message that tells the steward a todo is done. */
export function todoDoneMessage(identifier: string, title: string, note: string | null): string {
  const head = `${DELIVERY_PREFIX} Todo done ${identifier}: ${title}`;
  return note === null ? head : `${head}\n${note}`;
}

/** The message that tells the steward a todo marked done is open again. */
export function todoReopenedMessage(identifier: string, title: string): string {
  return `${DELIVERY_PREFIX} Todo reopened ${identifier}: ${title}`;
}
