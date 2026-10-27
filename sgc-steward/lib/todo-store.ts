// Where the todo list keeps its state: which todos were announced, and what
// each Done or Undo means to write to Linear. Both live in the plugin's
// SQLite database, so they survive a restart.

import type Database from "better-sqlite3";

/**
 * A Done or an Undo, kept before it writes to Linear. Its comment posts under
 * the action's own id, so a retry or a poll can finish it without posting a
 * second comment. Its message and the thread it goes to are fixed here too,
 * so a retry never changes what the steward hears, or who hears it.
 */
export interface TodoAction {
  /** The comment id it posts under, chosen before it writes. */
  id: string;
  kind: "done" | "reopen";
  issueId: string;
  identifier: string;
  title: string;
  /** The comment it posts. */
  body: string;
  /** The owner's note on a Done; null otherwise. */
  note: string | null;
  /** What it changes: the todo label, or the state. */
  change: "label" | "state";
  /** The label to remove or put back, or the state to move to. */
  targetId: string;
  /** For a Done: what Undo puts back, the label or the state before the Done. */
  restoreId: string | null;
  /** The steward thread its message goes to, as it was when the action began; null when none was set. */
  recipient: string | null;
  /** The steward's message, sent once the action finishes. */
  message: string;
  /** When it last started writing, epoch ms: the post window runs from here. */
  attemptedAt: number;
}

interface ActionRecord {
  id: string;
  kind: TodoAction["kind"];
  issue_id: string;
  identifier: string;
  title: string;
  body: string;
  note: string | null;
  change: TodoAction["change"];
  target_id: string;
  restore_id: string | null;
  recipient: string | null;
  message: string;
  attempted_at: number;
}

function toAction(row: ActionRecord): TodoAction {
  return {
    id: row.id,
    kind: row.kind,
    issueId: row.issue_id,
    identifier: row.identifier,
    title: row.title,
    body: row.body,
    note: row.note,
    change: row.change,
    targetId: row.target_id,
    restoreId: row.restore_id,
    recipient: row.recipient,
    message: row.message,
    attemptedAt: row.attempted_at,
  };
}

export type TodoStore = ReturnType<typeof createTodoStore>;

export function createTodoStore(db: Database.Database, now: () => number = () => Date.now()) {
  return {
    /**
     * Record the todos seen; returns how many are new and still to announce.
     * A todo that leaves the list is forgotten, so one that comes back is new.
     */
    reconcileSeen(todos: ReadonlyArray<{ id: string; identifier: string; title: string }>, notify: boolean): number {
      const at = now();
      const known = new Set((db.prepare("SELECT issue_id FROM seen_todos").all() as Array<{ issue_id: string }>).map((row) => row.issue_id));
      const current = new Set(todos.map((todo) => todo.id));
      const insert = db.prepare("INSERT INTO seen_todos (issue_id, identifier, title, first_seen_at, notified_at) VALUES (?, ?, ?, ?, ?)");
      const remove = db.prepare("DELETE FROM seen_todos WHERE issue_id = ?");
      let fresh = 0;
      db.transaction(() => {
        for (const todo of todos) {
          if (known.has(todo.id)) continue;
          insert.run(todo.id, todo.identifier, todo.title, at, notify ? null : at);
          if (notify) fresh += 1;
        }
        for (const id of known) if (!current.has(id)) remove.run(id);
      })();
      return fresh;
    },

    /** Todos no window has announced yet, oldest first; each is handed out once. */
    claimSeen(): Array<{ at: number; id: string; label: string; preview: string }> {
      const rows = db
        .prepare("UPDATE seen_todos SET notified_at = ? WHERE notified_at IS NULL RETURNING issue_id, identifier, title, first_seen_at")
        .all(now()) as Array<{ issue_id: string; identifier: string; title: string; first_seen_at: number }>;
      return rows.map((row) => ({ at: row.first_seen_at, id: row.issue_id, label: row.identifier, preview: row.title }));
    },

    /** Keep an action before it writes. */
    begin(action: Omit<TodoAction, "attemptedAt">): void {
      const at = now();
      db.prepare(
        `INSERT INTO todo_actions (id, kind, issue_id, identifier, title, body, note, change, target_id, restore_id, recipient, message, state, created_at, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(action.id, action.kind, action.issueId, action.identifier, action.title, action.body, action.note, action.change, action.targetId, action.restoreId, action.recipient, action.message, at, at);
    },

    /** An action starts writing again, so its post window starts again. */
    attempt(id: string): void {
      db.prepare("UPDATE todo_actions SET attempted_at = ? WHERE id = ? AND state = 'pending'").run(now(), id);
    },

    /** The unfinished action of one kind on an issue, if any; the schema allows one. */
    pending(issueId: string, kind: TodoAction["kind"]): TodoAction | null {
      const row = db.prepare("SELECT * FROM todo_actions WHERE issue_id = ? AND kind = ? AND state = 'pending'").get(issueId, kind) as ActionRecord | undefined;
      return row === undefined ? null : toAction(row);
    },

    /** Every unfinished action, oldest first. */
    unfinished(): TodoAction[] {
      return (db.prepare("SELECT * FROM todo_actions WHERE state = 'pending' ORDER BY created_at, id").all() as ActionRecord[]).map(toAction);
    },

    /** Mark an unfinished action finished; false when it was not unfinished. */
    finish(id: string): boolean {
      return db.prepare("UPDATE todo_actions SET state = 'finished', finished_at = ? WHERE id = ? AND state = 'pending'").run(now(), id).changes === 1;
    },

    /** Forget an action that will never finish. */
    abandon(id: string): void {
      db.prepare("DELETE FROM todo_actions WHERE id = ? AND state = 'pending'").run(id);
    },

    /** Forget finished actions older than `age` ms, so the table does not grow forever. */
    prune(age: number): void {
      db.prepare("DELETE FROM todo_actions WHERE state = 'finished' AND finished_at < ?").run(now() - age);
    },
  };
}
