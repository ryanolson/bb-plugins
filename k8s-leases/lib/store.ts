// The lease table and every write to it.
//
// All `bb k8s` commands, from every host, run in the one bb server process,
// and better-sqlite3 is synchronous. So each check-and-write below is one
// IMMEDIATE transaction with no await inside, and nothing can interleave
// with it: this is what keeps two hosts from taking the same GPUs, and two
// writers from holding one slot.
import type Database from "better-sqlite3";
import { CHARGED, type LeaseState } from "./contract.ts";
import { Refusal } from "./refusal.ts";
import type { Config } from "./settings.ts";

type Db = Database.Database;

export const MIGRATIONS = [
  `CREATE TABLE leases (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    cluster TEXT NOT NULL,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    uid TEXT NOT NULL,
    gpu_type TEXT NOT NULL,
    gpus INTEGER NOT NULL CHECK (gpus > 0),
    hours REAL NOT NULL CHECK (hours > 0),
    multi_node INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    renewals INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('active','revoking','releasing','released','torn-down')),
    reason TEXT,
    revoked_at INTEGER,
    grace_deadline INTEGER,
    ended_at INTEGER,
    op_token TEXT,
    op_deadline INTEGER,
    ns_expires_at INTEGER,
    last_host TEXT,
    last_checked_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`,
  `CREATE UNIQUE INDEX leases_live_namespace ON leases(cluster, namespace) WHERE state IN ('active','revoking','releasing')`,
  `CREATE INDEX leases_state ON leases(state)`,
  `CREATE TABLE extensions (
    lease_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    minutes REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('panel','renew')),
    expires_before INTEGER NOT NULL,
    expires_after INTEGER NOT NULL
  )`,
  `CREATE TABLE profiles (id INTEGER PRIMARY KEY CHECK (id = 1), host_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE approvals_used (approval TEXT PRIMARY KEY, lease_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE heartbeats (host_id TEXT PRIMARY KEY, last_ok_at INTEGER, last_try_at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL)`,
  `CREATE TABLE flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lease_id TEXT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    cleared_at INTEGER
  )`,
];

export interface LeaseRow {
  id: string;
  thread_id: string;
  cluster: string;
  context: string;
  namespace: string;
  uid: string;
  gpu_type: string;
  gpus: number;
  hours: number;
  multi_node: number;
  created_at: number;
  expires_at: number;
  renewals: number;
  state: LeaseState;
  reason: string | null;
  revoked_at: number | null;
  grace_deadline: number | null;
  ended_at: number | null;
  op_token: string | null;
  op_deadline: number | null;
  ns_expires_at: number | null;
  last_host: string | null;
  last_checked_at: number | null;
  failures: number;
  last_error: string | null;
}

export interface ExtensionRow {
  lease_id: string;
  at: number;
  minutes: number;
  source: "panel" | "renew";
  expires_before: number;
  expires_after: number;
}

export interface HeartbeatRow {
  host_id: string;
  last_ok_at: number | null;
  last_try_at: number;
  ok: number;
  detail: string;
}

export interface FlagRow {
  id: number;
  lease_id: string | null;
  at: number;
  kind: string;
  detail: string;
  cleared_at: number | null;
}

export interface AcquireRequest {
  id: string;
  thread: string;
  cluster: string;
  context: string;
  namespace: string;
  uid: string;
  gpuType: string;
  gpus: number;
  hours: number;
  /** For a multi-node lease, the approvals that match it; the first one not yet used is used up. */
  approvals: string[] | null;
}

/** Flags raised after this many failed reconciles in a row. */
export const FAILURES_BEFORE_FLAG = 3;

const LIVE = `state IN (${CHARGED.map((s) => `'${s}'`).join(",")})`;

/** Lease times are whole seconds, so they survive an `expires-at` written without milliseconds. */
export function wholeSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

export function createStore(db: Db, now: () => number) {
  const q = {
    get: db.prepare<[string], LeaseRow>("SELECT * FROM leases WHERE id = ?"),
    live: db.prepare<[], LeaseRow>(`SELECT * FROM leases WHERE ${LIVE} ORDER BY created_at, id`),
    ended: db.prepare<[], LeaseRow>(`SELECT * FROM leases WHERE NOT ${LIVE} ORDER BY COALESCE(ended_at, created_at) DESC, id LIMIT 200`),
    liveOn: db.prepare<[string, string], LeaseRow>(`SELECT * FROM leases WHERE cluster = ? AND namespace = ? AND ${LIVE}`),
    used: db.prepare<[string], { used: number | null }>(`SELECT SUM(gpus) AS used FROM leases WHERE gpu_type = ? AND ${LIVE}`),
    usedAll: db.prepare<[], { gpu_type: string; used: number }>(`SELECT gpu_type, SUM(gpus) AS used FROM leases WHERE ${LIVE} GROUP BY gpu_type`),
    byThread: db.prepare<[string], LeaseRow>("SELECT * FROM leases WHERE thread_id = ? AND state = 'active'"),
    extensions: db.prepare<[string], ExtensionRow>("SELECT * FROM extensions WHERE lease_id = ? ORDER BY at"),
    heartbeats: db.prepare<[], HeartbeatRow>("SELECT * FROM heartbeats ORDER BY host_id"),
    flags: db.prepare<[], FlagRow>("SELECT * FROM flags WHERE cleared_at IS NULL ORDER BY id"),
  };

  /** Move every expired active lease to revoking; its grace runs from its expiry, as the offline timer's does. */
  function sweepExpired(graceMs: number): void {
    const t = now();
    db.prepare(
      `UPDATE leases SET state = 'revoking', reason = 'expired', revoked_at = ?, grace_deadline = expires_at + ?, op_token = NULL, op_deadline = NULL
       WHERE state = 'active' AND expires_at <= ?`,
    ).run(t, graceMs, t);
  }

  function mustGet(id: string): LeaseRow {
    const row = q.get.get(id);
    if (row === undefined) throw new Refusal("lease_not_found", `No lease ${id}.`);
    return row;
  }

  function owned(id: string, thread: string | undefined): LeaseRow {
    const row = mustGet(id);
    if (thread === undefined || thread !== row.thread_id) {
      throw new Refusal("not_your_lease", `Lease ${id} belongs to ${row.thread_id}; only that thread may use it.`);
    }
    return row;
  }

  function freshHeartbeat(windowMs: number, hosts: readonly string[]): boolean {
    const since = now() - windowMs;
    return q.heartbeats.all().some((row) => hosts.includes(row.host_id) && row.last_ok_at !== null && row.last_ok_at > since);
  }

  function addFlag(leaseId: string | null, kind: string, detail: string): void {
    db.prepare("INSERT INTO flags (lease_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(leaseId, now(), kind, detail);
  }

  return {
    sweepExpired,

    /** The lease, after the expiry sweep, so an expired lease never reads as active. */
    get(id: string, cfg: Config): LeaseRow {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        return mustGet(id);
      }).immediate();
    },

    find(id: string): LeaseRow | undefined {
      return q.get.get(id);
    },

    live(): LeaseRow[] {
      return q.live.all();
    },

    /** Every live lease, then the latest 200 ended ones. */
    all(): LeaseRow[] {
      return [...q.live.all(), ...q.ended.all()];
    },

    activeOfThread(thread: string): LeaseRow[] {
      return q.byThread.all(thread);
    },

    liveOn(cluster: string, namespace: string): LeaseRow | undefined {
      return q.liveOn.get(cluster, namespace);
    },

    used(gpuType: string): number {
      return q.used.get(gpuType)?.used ?? 0;
    },

    usedAll(): Map<string, number> {
      return new Map(q.usedAll.all().map((row) => [row.gpu_type, row.used]));
    },

    freshHeartbeat,

    /**
     * The checks that the database decides, and the insert, in one
     * transaction. The caller has already confirmed the namespace on a host.
     */
    acquire(req: AcquireRequest, cfg: Config, heartbeatMs: number): LeaseRow {
      return db.transaction(() => {
        const t = now();
        sweepExpired(cfg.graceMs);
        if (!freshHeartbeat(heartbeatMs, cfg.hosts)) {
          throw new Refusal("enforcement_unhealthy", `No enforcement host has sent a heartbeat in ${heartbeatMs / 60_000} minutes.`);
        }
        const held = q.liveOn.get(req.cluster, req.namespace);
        if (held !== undefined) throw new Refusal("namespace_leased", `${req.namespace} on ${req.cluster} already has lease ${held.id} (${held.state}).`);
        const limit = cfg.limits[req.gpuType] ?? 0;
        const used = q.used.get(req.gpuType)?.used ?? 0;
        if (used + req.gpus > limit) {
          throw new Refusal("over_limit", `${req.gpus} ${req.gpuType} GPUs would make ${used + req.gpus}; the limit is ${limit} (${used} held).`);
        }
        if (req.approvals !== null) {
          const used = db.prepare<[string], { lease_id: string }>("SELECT lease_id FROM approvals_used WHERE approval = ?");
          const free = req.approvals.find((key) => used.get(key) === undefined);
          if (free === undefined) {
            throw new Refusal("multi_node_unapproved", `Each multi-node approval for ${req.namespace} is used already; one approval covers one lease.`);
          }
          db.prepare("INSERT INTO approvals_used (approval, lease_id, at) VALUES (?, ?, ?)").run(free, req.id, t);
        }
        db.prepare(
          `INSERT INTO leases (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
        ).run(req.id, req.thread, req.cluster, req.context, req.namespace, req.uid, req.gpuType, req.gpus, req.hours, req.approvals !== null ? 1 : 0, t, wholeSecond(t + req.hours * 3_600_000));
        return mustGet(req.id);
      }).immediate();
    },

    /** Take the one slot: only while active, unexpired, and free or past its deadline. */
    opBegin(id: string, thread: string | undefined, token: string, slotMs: number, cfg: Config): { token: string; deadline: number } {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        const row = owned(id, thread);
        if (row.state !== "active") throw new Refusal("lease_not_active", `Lease ${id} is ${row.state}.`);
        const t = now();
        const taken = db
          .prepare(
            `UPDATE leases SET op_token = ?, op_deadline = ?
             WHERE id = ? AND state = 'active' AND expires_at > ? AND (op_token IS NULL OR op_deadline <= ?)`,
          )
          .run(token, t + slotMs, id, t, t);
        if (taken.changes !== 1) {
          throw new Refusal("slot_busy", `Another write holds lease ${id}'s slot.`, { retry_at: new Date(row.op_deadline ?? t).toISOString() });
        }
        return { token, deadline: t + slotMs };
      }).immediate();
    },

    /** Free the slot if `token` still holds it. A lapsed token frees nothing. */
    opEnd(id: string, thread: string | undefined, token: string, cfg: Config): { state: LeaseState; lapsed: boolean } {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        owned(id, thread);
        const freed = db.prepare("UPDATE leases SET op_token = NULL, op_deadline = NULL WHERE id = ? AND op_token = ?").run(id, token);
        return { state: mustGet(id).state, lapsed: freed.changes !== 1 };
      }).immediate();
    },

    /** The owner returns the lease, and a revoking one skips the rest of its grace. Otherwise nothing changes. */
    release(id: string, thread: string | undefined, cfg: Config): LeaseRow {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        const row = owned(id, thread);
        if (row.state !== "active" && row.state !== "revoking") return row;
        db.prepare(
          "UPDATE leases SET state = 'releasing', reason = COALESCE(reason, 'released'), revoked_at = COALESCE(revoked_at, ?), op_token = NULL, op_deadline = NULL WHERE id = ?",
        ).run(now(), id);
        return mustGet(id);
      }).immediate();
    },

    /** An agent's renewal: by the owner, at most `maxRenewals`, never leaving more than `maxLeaseMs`. */
    renew(id: string, thread: string | undefined, cfg: Config): LeaseRow {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        const row = owned(id, thread);
        if (row.state !== "active") throw new Refusal("lease_not_active", `Lease ${id} is ${row.state}.`);
        if (row.renewals >= cfg.maxRenewals) throw new Refusal("renewals_used", `Lease ${id} has used its ${cfg.maxRenewals} renewal(s).`);
        const t = now();
        const after = wholeSecond(Math.min(row.expires_at + row.hours * 3_600_000, t + cfg.maxLeaseMs));
        // After a panel extension the hour limit could pull the expiry in; a renewal only ever adds time.
        if (after <= row.expires_at) {
          throw new Refusal("renew_not_needed", `Lease ${id} already runs until ${new Date(row.expires_at).toISOString()}; a renewal would not add time.`);
        }
        db.prepare("UPDATE leases SET expires_at = ?, renewals = renewals + 1 WHERE id = ?").run(after, id);
        db.prepare("INSERT INTO extensions (lease_id, at, minutes, source, expires_before, expires_after) VALUES (?, ?, ?, 'renew', ?, ?)").run(
          id,
          t,
          (after - row.expires_at) / 60_000,
          row.expires_at,
          after,
        );
        return mustGet(id);
      }).immediate();
    },

    /** Ryan's extension from the panel: not bound by the hour limit or renewals, only by `maxExtendMs` per extension. */
    extend(id: string, minutes: number, cfg: Config): LeaseRow {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        const row = mustGet(id);
        if (row.state !== "active") throw new Refusal("lease_not_active", `Lease ${id} is ${row.state}, so it cannot be extended.`);
        if (minutes * 60_000 > cfg.maxExtendMs) {
          throw new Refusal("extension_too_long", `One extension adds at most ${cfg.maxExtendMs / 3_600_000} h.`);
        }
        const after = wholeSecond(row.expires_at + minutes * 60_000);
        db.prepare("UPDATE leases SET expires_at = ? WHERE id = ?").run(after, id);
        db.prepare("INSERT INTO extensions (lease_id, at, minutes, source, expires_before, expires_after) VALUES (?, ?, ?, 'panel', ?, ?)").run(
          id,
          now(),
          minutes,
          row.expires_at,
          after,
        );
        addFlag(id, "extended", `Lease ${id} (${row.namespace} on ${row.cluster}) extended by ${minutes} min from the panel, to ${new Date(after).toISOString()}.`);
        return mustGet(id);
      }).immediate();
    },

    /** Start teardown. Only an active lease is revoked; one already in teardown keeps its deadline. */
    revoke(id: string, reason: string, graceDeadline: number): LeaseRow {
      return db.transaction(() => {
        db.prepare(
          `UPDATE leases SET state = 'revoking', reason = ?, revoked_at = ?, grace_deadline = ?, op_token = NULL, op_deadline = NULL
           WHERE id = ? AND state = 'active'`,
        ).run(reason, now(), graceDeadline, id);
        return mustGet(id);
      }).immediate();
    },

    /** A host saw the namespace gone, or re-created: the lease frees its GPUs. */
    end(id: string, why: string): LeaseRow {
      return db.transaction(() => {
        const row = mustGet(id);
        if (!CHARGED.includes(row.state)) return row;
        const final: LeaseState = row.state === "releasing" ? "released" : "torn-down";
        db.prepare(
          `UPDATE leases SET state = ?, reason = COALESCE(reason, ?), ended_at = ?, op_token = NULL, op_deadline = NULL, failures = 0, last_error = NULL WHERE id = ?`,
        ).run(final, why, now(), id);
        return mustGet(id);
      }).immediate();
    },

    /** What a host read of the namespace. Failures stay counted until a whole step works. */
    noteSeen(id: string, host: string, nsExpiresAt: number | null): void {
      db.prepare("UPDATE leases SET last_host = ?, last_checked_at = ?, ns_expires_at = ? WHERE id = ?").run(host, now(), nsExpiresAt, id);
    },

    /** A whole reconcile step worked: the failure count starts again. */
    clearFailures(id: string): void {
      db.prepare("UPDATE leases SET failures = 0, last_error = NULL WHERE id = ?").run(id);
    },

    /** A reconcile step that failed. Returns true the time it should be flagged. */
    noteFailure(id: string, error: string): boolean {
      return db.transaction(() => {
        db.prepare("UPDATE leases SET failures = failures + 1, last_error = ?, last_checked_at = ? WHERE id = ?").run(error, now(), id);
        return mustGet(id).failures === FAILURES_BEFORE_FLAG;
      }).immediate();
    },

    extensions(id: string): ExtensionRow[] {
      return q.extensions.all(id);
    },

    heartbeat(hostId: string, ok: boolean, detail: string): void {
      const t = now();
      db.prepare(
        `INSERT INTO heartbeats (host_id, last_ok_at, last_try_at, ok, detail) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at), last_try_at = excluded.last_try_at, ok = excluded.ok, detail = excluded.detail`,
      ).run(hostId, ok ? t : null, t, ok ? 1 : 0, detail);
    },

    saveProfiles(hostId: string, json: string): void {
      db.prepare("INSERT INTO profiles (id, host_id, at, json) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, at = excluded.at, json = excluded.json").run(
        hostId,
        now(),
        json,
      );
    },

    profiles(): { host_id: string; at: number; json: string } | undefined {
      return db.prepare<[], { host_id: string; at: number; json: string }>("SELECT host_id, at, json FROM profiles WHERE id = 1").get();
    },

    heartbeats(): HeartbeatRow[] {
      return q.heartbeats.all();
    },

    flag: addFlag,

    flags(): FlagRow[] {
      return q.flags.all();
    },

    clearFlag(id: number): boolean {
      return db.prepare("UPDATE flags SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL").run(now(), id).changes === 1;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
