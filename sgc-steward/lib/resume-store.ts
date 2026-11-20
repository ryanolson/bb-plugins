// Where a Resume of a paused issue keeps its state: what it means to write to
// Linear, and the message it sends when it finishes, in the plugin's SQLite
// database. It is kept before the first write, so a retry, or a poll after a
// restart, finishes the same Resume with the same comment id, note, and
// steward thread, and never posts a second comment.

import type Database from "better-sqlite3";

export interface ResumeAction {
  /** The comment id it posts under, chosen before it writes. */
  id: string;
  issueId: string;
  identifier: string;
  title: string;
  /** The comment it posts. */
  body: string;
  note: string | null;
  /** The paused label to remove. */
  labelId: string;
  /** The Todo state to move the issue to. */
  stateId: string;
  /** The steward thread its message goes to, as it was when the Resume began; null when none was set. */
  recipient: string | null;
  message: string;
  /** When it last started writing, epoch ms: the post window runs from here. */
  attemptedAt: number;
}

interface ActionRecord {
  id: string;
  issue_id: string;
  identifier: string;
  title: string;
  body: string;
  note: string | null;
  label_id: string;
  state_id: string;
  recipient: string | null;
  message: string;
  attempted_at: number;
}

function toAction(row: ActionRecord): ResumeAction {
  return {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    title: row.title,
    body: row.body,
    note: row.note,
    labelId: row.label_id,
    stateId: row.state_id,
    recipient: row.recipient,
    message: row.message,
    attemptedAt: row.attempted_at,
  };
}

export type ResumeStore = ReturnType<typeof createResumeStore>;

export function createResumeStore(db: Database.Database, now: () => number = () => Date.now()) {
  return {
    /** Keep a Resume before it writes. */
    begin(action: Omit<ResumeAction, "attemptedAt">): void {
      const at = now();
      db.prepare(
        `INSERT INTO resume_actions (id, issue_id, identifier, title, body, note, label_id, state_id, recipient, message, state, created_at, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(action.id, action.issueId, action.identifier, action.title, action.body, action.note, action.labelId, action.stateId, action.recipient, action.message, at, at);
    },

    /** A Resume starts writing again, so its post window starts again. */
    attempt(id: string): void {
      db.prepare("UPDATE resume_actions SET attempted_at = ? WHERE id = ? AND state = 'pending'").run(now(), id);
    },

    /** The unfinished Resume of an issue, if any; the schema allows one. */
    pending(issueId: string): ResumeAction | null {
      const row = db.prepare("SELECT * FROM resume_actions WHERE issue_id = ? AND state = 'pending'").get(issueId) as ActionRecord | undefined;
      return row === undefined ? null : toAction(row);
    },

    /** Every unfinished Resume, oldest first. */
    unfinished(): ResumeAction[] {
      return (db.prepare("SELECT * FROM resume_actions WHERE state = 'pending' ORDER BY created_at, id").all() as ActionRecord[]).map(toAction);
    },

    /** Mark an unfinished Resume finished; false when it was not unfinished. */
    finish(id: string): boolean {
      return db.prepare("UPDATE resume_actions SET state = 'finished', finished_at = ? WHERE id = ? AND state = 'pending'").run(now(), id).changes === 1;
    },

    /** Forget a Resume that will never finish. */
    abandon(id: string): void {
      db.prepare("DELETE FROM resume_actions WHERE id = ? AND state = 'pending'").run(id);
    },

    /** Forget finished Resumes older than `age` ms. */
    prune(age: number): void {
      db.prepare("DELETE FROM resume_actions WHERE state = 'finished' AND finished_at < ?").run(now() - age);
    },
  };
}
