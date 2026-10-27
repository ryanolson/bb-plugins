// Where asked questions, their deliveries, and their Linear records live: the
// plugin's SQLite database, so all of them survive a restart. Each answer is
// saved in one transaction with the delivery and record it needs, so a crash
// leaves work to retry, never an answer without one.

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { ASK_LIMITS, type Ask, type AskAnswer, type AskOption } from "./asks.ts";

/**
 * Every migration after seen_blocks, in order: the plugin's one migration
 * list. The host keys each statement by its index and refuses an edited one,
 * so only append; never reorder or edit.
 */
export const STORE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asks (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    thread_title TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    issue TEXT,
    asked_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    answered_at INTEGER,
    notified_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    label TEXT NOT NULL,
    message TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    issue_id TEXT,
    held_at INTEGER,
    UNIQUE (source, ref, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS records (
    ask_id TEXT PRIMARY KEY,
    issue TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    comment_id TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  // Who withdrew a question, and why: the asking thread, or the steward with a reason.
  `ALTER TABLE asks ADD COLUMN withdrawn_by TEXT`,
  `ALTER TABLE asks ADD COLUMN withdraw_reason TEXT`,
  `ALTER TABLE asks ADD COLUMN withdrawn_at INTEGER`,
  // The owner's todos already seen, so each new one is announced once.
  `CREATE TABLE IF NOT EXISTS seen_todos (
    issue_id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    notified_at INTEGER
  )`,
];

export type AskState = "open" | "answered" | "withdrawn";

export interface AskRow extends Ask {
  state: AskState;
  answer: AskAnswer | null;
  answeredAt: number | null;
  /** The thread that withdrew it; null unless withdrawn, and for a withdrawal from the owner's terminal. */
  withdrawnBy: string | null;
  withdrawReason: string | null;
  withdrawnAt: number | null;
}

export type DeliverySource = "ask" | "linear" | "withdrawal" | "todo";

/**
 * One message to send to a thread: the answer to its bb question or to its
 * Linear block, the notice that the steward withdrew its question, or the
 * steward's news that the owner marked a todo done or reopened it. An
 * answer to a block is kept held before it posts, so a restart while the
 * post is in flight cannot lose it. Whoever moves a row out of held sends
 * it, once; after that, only the owner's retry sends it again, because a
 * send that seemed to fail may have arrived.
 */
export interface Delivery {
  id: string;
  source: DeliverySource;
  /** The bb question id, or the Linear answer comment id. */
  ref: string;
  threadId: string;
  /** What the page shows it as: the question id, the issue identifier, or "Withdrawal of" the question id. */
  label: string;
  message: string;
  /** held: the Linear answer is not known to be posted, so it is neither shown nor sent. */
  state: "held" | "pending" | "delivered" | "failed";
  error: string | null;
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
  /** The Linear issue of a block answer, where its post is checked; null for a bb question. */
  issueId: string | null;
}

/** A delivery the page lists: one not sent yet, or whose send failed. */
export type Undelivered = Delivery & { state: "pending" | "failed" };

/** A Linear answer whose deliveries are still held. */
export interface HeldAnswer {
  /** The answer's comment id. */
  ref: string;
  issueId: string;
  /** The issue identifier. */
  label: string;
  /** When the latest post of the answer began, epoch ms. */
  heldAt: number;
}

/** The Linear comment that records a bb question and its answer. */
export interface RecordRow {
  askId: string;
  issue: string;
  body: string;
  state: "pending" | "posted" | "failed";
  commentId: string | null;
  error: string | null;
  attempts: number;
}

export type Outcome = { ok: true } | { ok: false; error: string };

export type WithdrawOutcome = "withdrawn" | "not_found" | "not_yours" | "not_open";

/** A withdrawal: who acts, and what goes out with it. */
export interface Withdrawal {
  /** The thread the caller acts for: the calling thread, or `--thread` from the owner's terminal. */
  thread: string;
  /** The calling thread, stored as the withdrawer; null for the owner's terminal. */
  by: string | null;
  /** The caller is the steward, who may withdraw any thread's question. */
  steward: boolean;
  reason: string | null;
  /** The message for the asking thread, or null when it is not told. */
  notice: string | null;
  /** The comment that records the withdrawal on the question's issue, or null. */
  record: { issue: string; body: string } | null;
}

/** What happened to an asked question: stored, already open, or refused at a cap. */
export type Admission = { kind: "asked" | "existing"; id: string } | { kind: "full"; scope: "thread" | "total"; open: number };

function token(bytes: number): string {
  return [...randomBytes(bytes)].map((byte) => (byte % 36).toString(36)).join("");
}

export function createAskId(): string {
  return `bbq_${token(10)}`;
}

interface AskRecord {
  id: string;
  thread_id: string;
  thread_title: string;
  question: string;
  options: string;
  issue: string | null;
  asked_at: number;
  state: AskState;
  answer: string | null;
  answered_at: number | null;
  withdrawn_by: string | null;
  withdraw_reason: string | null;
  withdrawn_at: number | null;
}

interface DeliveryRecord {
  id: string;
  source: DeliverySource;
  ref: string;
  thread_id: string;
  label: string;
  message: string;
  state: Delivery["state"];
  error: string | null;
  attempts: number;
  created_at: number;
  delivered_at: number | null;
  issue_id: string | null;
}

interface RecordRecord {
  ask_id: string;
  issue: string;
  body: string;
  state: RecordRow["state"];
  comment_id: string | null;
  error: string | null;
  attempts: number;
}

function toAsk(row: AskRecord): AskRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    question: row.question,
    options: JSON.parse(row.options) as AskOption[],
    issue: row.issue,
    askedAt: row.asked_at,
    state: row.state,
    answer: row.answer === null ? null : (JSON.parse(row.answer) as AskAnswer),
    answeredAt: row.answered_at,
    withdrawnBy: row.withdrawn_by,
    withdrawReason: row.withdraw_reason,
    withdrawnAt: row.withdrawn_at,
  };
}

function toDelivery(row: DeliveryRecord): Delivery {
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    threadId: row.thread_id,
    label: row.label,
    message: row.message,
    state: row.state,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    issueId: row.issue_id,
  };
}

function toRecord(row: RecordRecord): RecordRow {
  return {
    askId: row.ask_id,
    issue: row.issue,
    body: row.body,
    state: row.state,
    commentId: row.comment_id,
    error: row.error,
    attempts: row.attempts,
  };
}

export type AskStore = ReturnType<typeof createAskStore>;

export function createAskStore(db: Database.Database, now: () => number = Date.now) {
  const getAsk = db.prepare("SELECT * FROM asks WHERE id = ?");
  const getDelivery = db.prepare("SELECT * FROM deliveries WHERE id = ?");
  const deliveryByKey = db.prepare("SELECT * FROM deliveries WHERE source = ? AND ref = ? AND thread_id = ?");
  const insertDelivery = db.prepare(
    `INSERT OR IGNORE INTO deliveries (id, source, ref, thread_id, label, message, state, issue_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRecord = db.prepare("INSERT OR IGNORE INTO records (ask_id, issue, body, state, created_at) VALUES (?, ?, ?, 'pending', ?)");
  // Each post of an answer gets the whole post window, so holding a
  // delivery again restarts the window of one still held.
  const holdDelivery = db.prepare(
    `INSERT INTO deliveries (id, source, ref, thread_id, label, message, state, issue_id, created_at, held_at)
     VALUES (?, 'linear', ?, ?, ?, ?, 'held', ?, ?, ?)
     ON CONFLICT (source, ref, thread_id) DO UPDATE SET held_at = excluded.held_at WHERE state = 'held'`,
  );

  return {
    /**
     * Store a question, unless the same one is open from the same thread, or
     * a cap is full. The checks and the insert are one transaction, so two
     * asks at once cannot both pass them. A repeat at a cap still gets its
     * id. `notified` stores the question as already announced, when
     * notifications are off.
     */
    admit(ask: Ask, notified: boolean): Admission {
      return db.transaction((): Admission => {
        const same = db
          .prepare("SELECT id FROM asks WHERE state = 'open' AND thread_id = ? AND question = ? AND options = ? AND issue IS ?")
          .get(ask.threadId, ask.question, JSON.stringify(ask.options), ask.issue) as { id: string } | undefined;
        if (same !== undefined) return { kind: "existing", id: same.id };
        const open = db
          .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(thread_id = ?), 0) AS thread FROM asks WHERE state = 'open'")
          .get(ask.threadId) as { total: number; thread: number };
        if (open.thread >= ASK_LIMITS.openPerThread) return { kind: "full", scope: "thread", open: open.thread };
        if (open.total >= ASK_LIMITS.openTotal) return { kind: "full", scope: "total", open: open.total };
        db.prepare(
          `INSERT INTO asks (id, thread_id, thread_title, question, options, issue, asked_at, state, notified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        ).run(ask.id, ask.threadId, ask.threadTitle, ask.question, JSON.stringify(ask.options), ask.issue, ask.askedAt, notified ? now() : null);
        return { kind: "asked", id: ask.id };
      })();
    },

    get(id: string): AskRow | null {
      const row = getAsk.get(id) as AskRecord | undefined;
      return row === undefined ? null : toAsk(row);
    },

    listOpen(): AskRow[] {
      return (db.prepare("SELECT * FROM asks WHERE state = 'open' ORDER BY asked_at, id").all() as AskRecord[]).map(toAsk);
    },

    /**
     * Withdraw an open question. Only its own thread may, unless the caller
     * is the steward. The notice to the asker and the record for the issue
     * are saved in the same transaction, so a crash leaves them to retry.
     * Only an open question is withdrawn, so a withdrawal and an answer that
     * race have one winner, and the loser saves nothing.
     */
    withdraw(id: string, withdrawal: Withdrawal): WithdrawOutcome {
      return db.transaction((): WithdrawOutcome => {
        const row = getAsk.get(id) as AskRecord | undefined;
        if (row === undefined) return "not_found";
        if (row.thread_id !== withdrawal.thread && !withdrawal.steward) return "not_yours";
        const at = now();
        const changed = db
          .prepare("UPDATE asks SET state = 'withdrawn', withdrawn_by = ?, withdraw_reason = ?, withdrawn_at = ? WHERE id = ? AND state = 'open'")
          .run(withdrawal.by, withdrawal.reason, at, id).changes;
        if (changed !== 1) return "not_open";
        if (withdrawal.notice !== null) {
          insertDelivery.run(`dlv_${token(10)}`, "withdrawal", id, row.thread_id, `Withdrawal of ${id}`, withdrawal.notice, "pending", null, at);
        }
        if (withdrawal.record !== null) insertRecord.run(id, withdrawal.record.issue, withdrawal.record.body, at);
        return "withdrawn";
      })();
    },

    /**
     * Save an answer with the delivery to the asking thread and, when the
     * question names an issue, the record to post. Only an open question
     * takes an answer, so a second submit or an answer racing a withdraw
     * changes nothing.
     */
    answer(
      id: string,
      answer: AskAnswer,
      delivery: { message: string; label: string },
      record: { issue: string; body: string } | null,
    ): "answered" | "not_found" | "not_open" {
      return db.transaction(() => {
        const row = getAsk.get(id) as AskRecord | undefined;
        if (row === undefined) return "not_found" as const;
        const at = now();
        const changed = db
          .prepare("UPDATE asks SET state = 'answered', answer = ?, answered_at = ? WHERE id = ? AND state = 'open'")
          .run(JSON.stringify(answer), at, id).changes;
        if (changed !== 1) return "not_open" as const;
        insertDelivery.run(`dlv_${token(10)}`, "ask", id, row.thread_id, id, delivery.message, "pending", null, at);
        if (record !== null) insertRecord.run(id, record.issue, record.body, at);
        return "answered" as const;
      })();
    },

    /**
     * Keep one message to send. Returns it to the call that kept it, which
     * sends it, once; null when the same message was kept before.
     */
    keep(delivery: { source: DeliverySource; ref: string; threadId: string; label: string; message: string }): Delivery | null {
      const { source, ref, threadId, label, message } = delivery;
      const kept = insertDelivery.run(`dlv_${token(10)}`, source, ref, threadId, label, message, "pending", null, now()).changes;
      return kept === 1 ? toDelivery(deliveryByKey.get(source, ref, threadId) as DeliveryRecord) : null;
    },

    /**
     * Keep the deliveries of a Linear answer, one per thread, held, before
     * the answer posts. A delivery already released stays as it is.
     */
    hold(answer: { ref: string; issueId: string; label: string; message: string }, threadIds: readonly string[]): void {
      db.transaction(() => {
        const at = now();
        for (const threadId of threadIds) {
          holdDelivery.run(`dlv_${token(10)}`, answer.ref, threadId, answer.label, answer.message, answer.issueId, at, at);
        }
      })();
    },

    /** Mark the held deliveries of a posted answer pending and return them. The caller sends exactly these. */
    release(ref: string): Delivery[] {
      const rows = db
        .prepare("UPDATE deliveries SET state = 'pending' WHERE source = 'linear' AND ref = ? AND state = 'held' RETURNING *")
        .all(ref) as DeliveryRecord[];
      return rows.map(toDelivery);
    },

    /** Forget the held deliveries of an answer that never posted. */
    drop(ref: string): void {
      db.prepare("DELETE FROM deliveries WHERE source = 'linear' AND ref = ? AND state = 'held'").run(ref);
    },

    /** Linear answers whose deliveries are still held, oldest first. */
    held(): HeldAnswer[] {
      return db
        .prepare(
          `SELECT ref, issue_id AS issueId, label, MAX(held_at) AS heldAt FROM deliveries
           WHERE source = 'linear' AND state = 'held' GROUP BY ref, issue_id, label ORDER BY heldAt, ref`,
        )
        .all() as HeldAnswer[];
    },

    getDelivery(id: string): Delivery | null {
      const row = getDelivery.get(id) as DeliveryRecord | undefined;
      return row === undefined ? null : toDelivery(row);
    },

    deliveryFor(source: DeliverySource, ref: string, threadId: string): Delivery | null {
      const row = deliveryByKey.get(source, ref, threadId) as DeliveryRecord | undefined;
      return row === undefined ? null : toDelivery(row);
    },

    markDelivery(id: string, outcome: Outcome): void {
      if (outcome.ok) {
        db.prepare("UPDATE deliveries SET state = 'delivered', error = NULL, attempts = attempts + 1, delivered_at = ? WHERE id = ?").run(now(), id);
      } else {
        db.prepare("UPDATE deliveries SET state = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?").run(outcome.error, id);
      }
    },

    /** Deliveries to list for the owner, pending or failed, oldest first. */
    undelivered(): Undelivered[] {
      const rows = db.prepare("SELECT * FROM deliveries WHERE state IN ('pending', 'failed') ORDER BY created_at, id").all() as DeliveryRecord[];
      return rows.map(toDelivery) as Undelivered[];
    },

    record(askId: string): RecordRow | null {
      const row = db.prepare("SELECT * FROM records WHERE ask_id = ?").get(askId) as RecordRecord | undefined;
      return row === undefined ? null : toRecord(row);
    },

    markRecord(askId: string, outcome: { ok: true; commentId: string } | { ok: false; error: string }): void {
      if (outcome.ok) {
        db.prepare("UPDATE records SET state = 'posted', comment_id = ?, error = NULL, attempts = attempts + 1 WHERE ask_id = ?").run(outcome.commentId, askId);
      } else {
        db.prepare("UPDATE records SET state = 'failed', error = ?, attempts = attempts + 1 WHERE ask_id = ?").run(outcome.error, askId);
      }
    },

    /** Records not yet posted, pending or failed, oldest first. */
    unposted(): RecordRow[] {
      return (db.prepare("SELECT * FROM records WHERE state != 'posted' ORDER BY created_at, ask_id").all() as RecordRecord[]).map(toRecord);
    },

    /** Open questions no window has announced yet; each is handed out once. */
    claim(): AskRow[] {
      const rows = db
        .prepare("UPDATE asks SET notified_at = ? WHERE notified_at IS NULL AND state = 'open' RETURNING *")
        .all(now()) as AskRecord[];
      return rows.map(toAsk).sort((a, b) => a.askedAt - b.askedAt || a.id.localeCompare(b.id));
    },
  };
}
