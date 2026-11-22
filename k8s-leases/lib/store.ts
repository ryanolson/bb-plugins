// The lease table and every write to it.
//
// All `bb k8s` commands, from every host, run in the one bb server process,
// and better-sqlite3 is synchronous. So each check-and-write below is one
// IMMEDIATE transaction with no await inside, and nothing can interleave
// with it: this is what keeps two hosts from taking the same GPUs, and two
// writers from holding one slot.
import type Database from "better-sqlite3";
import { CHARGED, type LeaseState } from "./contract.ts";
import { own } from "./own.ts";
import { Refusal } from "./refusal.ts";
import type { Config } from "./settings.ts";

type Db = Database.Database;

/**
 * The schema. Version 1 is the first one installed, as one statement.
 * From the first install on, migrations are append-only: never edit or
 * reorder a shipped statement; add a new one after it.
 */
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
    last_error TEXT,
    down_first_at INTEGER,
    stuck_flagged INTEGER NOT NULL DEFAULT 0
  );
CREATE UNIQUE INDEX leases_live_namespace ON leases(context, namespace) WHERE state IN ('active','revoking','releasing');
CREATE UNIQUE INDEX leases_live_uid ON leases(uid) WHERE state IN ('active','revoking','releasing');
CREATE INDEX leases_state ON leases(state);
CREATE TABLE extensions (
    lease_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    minutes REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('panel','renew')),
    expires_before INTEGER NOT NULL,
    expires_after INTEGER NOT NULL
  );
CREATE TABLE profiles (id INTEGER PRIMARY KEY CHECK (id = 1), host_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE approvals_used (approval TEXT PRIMARY KEY, lease_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE heartbeats (host_id TEXT PRIMARY KEY, last_ok_at INTEGER, last_try_at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);
CREATE TABLE flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lease_id TEXT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    cleared_at INTEGER
  )`,
  // Version 2: claims of a pre-made namespace. A claimed lease's row is its claim, its charge and its
  // completion: it has a request id (a retry returns its recorded outcome), the lease it replaced, and an
  // attempt epoch that moves with every write attempt opened or resolved. `attempts` holds each guard
  // write, recorded before it is sent and resolved after.
  `ALTER TABLE leases ADD COLUMN mode TEXT NOT NULL DEFAULT 'created' CHECK (mode IN ('created','claimed'));
ALTER TABLE leases ADD COLUMN request_id TEXT;
ALTER TABLE leases ADD COLUMN predecessor TEXT;
ALTER TABLE leases ADD COLUMN attempt_epoch INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX leases_request ON leases(request_id) WHERE request_id IS NOT NULL;
CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('create','patch','delete')),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    target_uid TEXT,
    target_rv TEXT,
    opened_at INTEGER NOT NULL,
    resolved_at INTEGER,
    outcome TEXT CHECK (outcome IN ('committed','failed','superseded'))
  );
CREATE INDEX attempts_open ON attempts(lease_id) WHERE resolved_at IS NULL`,
  // Version 3: the lease fence. `claim_seq` numbers each claim of a namespace, strictly rising and never
  // reused, so the gate ConfigMap the guard writes can only move forward; `trial` marks an audit-mode trial
  // claim; `fence_retired_proof` is the proof URL a person recorded for a fence retired for good.
  `ALTER TABLE leases ADD COLUMN claim_seq INTEGER;
ALTER TABLE leases ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leases ADD COLUMN fence_retired_proof TEXT;
CREATE UNIQUE INDEX leases_claim_seq ON leases(context, namespace, claim_seq) WHERE claim_seq IS NOT NULL`,
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
  /** When the first `down` of this lease started. */
  down_first_at: number | null;
  stuck_flagged: number;
  /** `created`: a namespace the guard made. `claimed`: the profile's pre-made namespace. */
  mode: "created" | "claimed";
  request_id: string | null;
  predecessor: string | null;
  attempt_epoch: number;
  /** A claim's sequence number on its context and namespace; null for a created lease. */
  claim_seq: number | null;
  /** 1 for a trial claim under an audit-mode fence. */
  trial: number;
  /** The proof URL of a retired fence, recorded by a person; only then may a teardown complete as `retired`. */
  fence_retired_proof: string | null;
}

export interface AttemptRow {
  id: string;
  lease_id: string;
  verb: "create" | "patch" | "delete";
  kind: string;
  name: string;
  target_uid: string | null;
  target_rv: string | null;
  opened_at: number;
  resolved_at: number | null;
  outcome: "committed" | "failed" | "superseded" | null;
}

export interface AttemptTarget {
  attempt: string;
  verb: "create" | "patch" | "delete";
  kind: string;
  name: string;
  uid: string | null;
  rv: string | null;
}

export type AttemptOutcome = "committed" | "failed" | "superseded";
export interface Resolution {
  attempt: string;
  outcome: AttemptOutcome;
}

export interface ClaimRequest extends Omit<AcquireRequest, "thread"> {
  /** The authenticated caller: the lease's owner. */
  thread: string;
  request: string;
  /** The lease this claim expects to replace, or null for none. */
  replaces: string | null;
  /** A trial claim (`--audit-trial`); the caller has checked the fence allows one. */
  trial: boolean;
}

/**
 * What a claimed teardown reports about the fence, as the host entry passed it on: fields it could not
 * read are absent.
 */
export interface FenceReport {
  /** The gate as read back after the teardown wrote `closing`. */
  fence?: { lease_id: string; seq: number; state: string };
  drain_monotonic_seconds?: number;
  armed?: "continuous" | "retired";
  /** The namespace's enrollment label at the end of the teardown, or null. */
  lease_fence?: string | null;
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

/**
 * The least drain, W, a claimed teardown must report between reading its gate back as `closing` and its
 * final inventory read: a Pod create admitted while the gate was open has this long to land and be seen.
 * The plugin's own constant: a value the host reports is never the minimum.
 */
export const DRAIN_MS = 120_000;

export interface StoreOptions {
  /** Tests only: a shorter W. */
  drainMs?: number;
}

/** Flags raised after this many failed reconciles in a row. */
export const FAILURES_BEFORE_FLAG = 3;

const LIVE = `state IN (${CHARGED.map((s) => `'${s}'`).join(",")})`;

/** Lease times are whole seconds, so they survive an `expires-at` written without milliseconds. */
export function wholeSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

export function createStore(db: Db, now: () => number, options: StoreOptions = {}) {
  const drainMs = options.drainMs ?? DRAIN_MS;
  const q = {
    get: db.prepare<[string], LeaseRow>("SELECT * FROM leases WHERE id = ?"),
    live: db.prepare<[], LeaseRow>(`SELECT * FROM leases WHERE ${LIVE} ORDER BY created_at, id`),
    ended: db.prepare<[], LeaseRow>(`SELECT * FROM leases WHERE NOT ${LIVE} ORDER BY COALESCE(ended_at, created_at) DESC, id LIMIT 200`),
    // By kube context, not profile name: two profile names for one context are one cluster.
    liveOn: db.prepare<[string, string], LeaseRow>(`SELECT * FROM leases WHERE context = ? AND namespace = ? AND ${LIVE}`),
    // Two kube contexts can reach one cluster: the namespace UID is the namespace.
    liveUid: db.prepare<[string], LeaseRow>(`SELECT * FROM leases WHERE uid = ? AND ${LIVE}`),
    used: db.prepare<[string], { used: number | null }>(`SELECT SUM(gpus) AS used FROM leases WHERE gpu_type = ? AND ${LIVE}`),
    usedAll: db.prepare<[], { gpu_type: string; used: number }>(`SELECT gpu_type, SUM(gpus) AS used FROM leases WHERE ${LIVE} GROUP BY gpu_type`),
    byThread: db.prepare<[string], LeaseRow>("SELECT * FROM leases WHERE thread_id = ? AND state = 'active'"),
    extensions: db.prepare<[string], ExtensionRow>("SELECT * FROM extensions WHERE lease_id = ? ORDER BY at"),
    heartbeats: db.prepare<[], HeartbeatRow>("SELECT * FROM heartbeats ORDER BY host_id"),
    flags: db.prepare<[], FlagRow>("SELECT * FROM flags WHERE cleared_at IS NULL ORDER BY id"),
    byRequest: db.prepare<[string], LeaseRow>("SELECT * FROM leases WHERE request_id = ?"),
    latestOn: db.prepare<[string, string], LeaseRow>("SELECT * FROM leases WHERE context = ? AND namespace = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    openAttempts: db.prepare<[string], AttemptRow>("SELECT * FROM attempts WHERE lease_id = ? AND resolved_at IS NULL ORDER BY opened_at, id"),
  };

  /** Resolve the open attempts named, once each; every one resolved moves the lease's attempt epoch. */
  function resolve(id: string, resolutions: readonly Resolution[]): number {
    let done = 0;
    for (const r of resolutions) {
      const changed = db
        .prepare("UPDATE attempts SET resolved_at = ?, outcome = ? WHERE id = ? AND lease_id = ? AND resolved_at IS NULL")
        .run(now(), r.outcome, r.attempt, id).changes;
      done += changed;
    }
    if (done > 0) db.prepare("UPDATE leases SET attempt_epoch = attempt_epoch + ? WHERE id = ?").run(done, id);
    return done;
  }

  function terms(row: LeaseRow, req: ClaimRequest): boolean {
    // A trial is a term: the guard keeps a trial's limits only while the lease says trial.
    return row.gpu_type === req.gpuType && row.gpus === req.gpus && row.hours === req.hours && row.cluster === req.cluster && (row.trial === 1) === req.trial;
  }

  /**
   * Why a claimed teardown's fence report cannot complete this lease, or null when it can: its own gate
   * read back `closing` for this lease and seq, a drain of at least W, and a fence armed throughout, or
   * retired with a recorded proof and the namespace no longer enrolled.
   */
  function fenceRefusal(row: LeaseRow, report: FenceReport): string | null {
    const fence = report.fence;
    if (fence === undefined) return "the report has no gate read back";
    if (fence.state !== "closing" || fence.lease_id !== row.id || row.claim_seq === null || fence.seq !== row.claim_seq) {
      return `the gate read back ${fence.state}(${fence.lease_id}, ${fence.seq}), not closing(${row.id}, ${row.claim_seq ?? "no seq"})`;
    }
    const drain = report.drain_monotonic_seconds;
    if (drain === undefined || !(drain * 1000 >= drainMs)) return `the drain was ${drain ?? "not reported"} s, less than ${drainMs / 1000} s`;
    if (report.armed === "continuous") return null;
    if (report.armed === "retired") {
      if (row.fence_retired_proof === null) return "the fence reads retired, but nobody recorded a proof with lease fence-retired";
      if (report.lease_fence === undefined || report.lease_fence === "true") return `the fence reads retired, but the namespace's enrollment label reads ${report.lease_fence ?? "unknown"}`;
      return null;
    }
    return "the report does not say the fence was armed throughout";
  }

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

    byRequest(request: string): LeaseRow | undefined {
      return q.byRequest.get(request);
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

    liveOn(context: string, namespace: string): LeaseRow | undefined {
      return q.liveOn.get(context, namespace);
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
        const held = q.liveOn.get(req.context, req.namespace) ?? q.liveUid.get(req.uid);
        if (held !== undefined) throw new Refusal("namespace_leased", `${req.namespace} on ${req.cluster} already has lease ${held.id} (${held.state}).`);
        const limit = own(cfg.limits, req.gpuType) ?? 0;
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
        const open = q.openAttempts.all(id);
        if (open.length > 0) {
          // A write whose outcome is unknown may still land: the next budget-checked write waits for it.
          throw new Refusal("attempt_unresolved", `Lease ${id} has a write whose outcome is unknown (${open.map((a) => `${a.verb} ${a.kind}/${a.name}`).join(", ")}); k8s-guard resolves it first.`);
        }
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

    /**
     * Claim the pre-made namespace, in one transaction: the recorded outcome of the same request; else
     * health, exclusivity (the same owner adopts its matching active lease), the predecessor, the
     * budget, and the insert. The caller has confirmed the namespace on a host.
     */
    claim(req: ClaimRequest, cfg: Config, heartbeatMs: number, fault?: () => void): { row: LeaseRow; outcome: "granted" | "adopted" | "replayed" } {
      return db.transaction(() => {
        const prior = q.byRequest.get(req.request);
        if (prior !== undefined) {
          if (prior.thread_id !== req.thread) throw new Refusal("request_conflict", `Request ${req.request} belongs to another thread.`);
          return { row: prior, outcome: "replayed" as const };
        }
        const t = now();
        sweepExpired(cfg.graceMs);
        if (!freshHeartbeat(heartbeatMs, cfg.hosts)) {
          throw new Refusal("enforcement_unhealthy", `No enforcement host has sent a heartbeat in ${heartbeatMs / 60_000} minutes.`);
        }
        const held = q.liveOn.get(req.context, req.namespace) ?? q.liveUid.get(req.uid);
        if (held !== undefined) {
          if (held.mode === "claimed" && held.state === "active" && held.thread_id === req.thread && held.uid === req.uid && terms(held, req)) {
            return { row: held, outcome: "adopted" as const };
          }
          throw new Refusal("namespace_leased", `${req.namespace} on ${req.cluster} already has lease ${held.id} (${held.state}).`);
        }
        const latest = q.latestOn.get(req.context, req.namespace);
        if ((latest?.id ?? null) !== req.replaces) {
          throw new Refusal("predecessor_mismatch", `${req.namespace}'s latest lease is ${latest?.id ?? "none"}, not ${req.replaces ?? "none"}; read it again before you claim.`, {
            current: latest?.id ?? "none",
          });
        }
        const limit = own(cfg.limits, req.gpuType) ?? 0;
        const used = q.used.get(req.gpuType)?.used ?? 0;
        if (used + req.gpus > limit) {
          throw new Refusal("over_limit", `${req.gpus} ${req.gpuType} GPUs would make ${used + req.gpus}; the limit is ${limit} (${used} held).`);
        }
        if (req.approvals !== null) {
          const usedApproval = db.prepare<[string], { lease_id: string }>("SELECT lease_id FROM approvals_used WHERE approval = ?");
          const free = req.approvals.find((key) => usedApproval.get(key) === undefined);
          if (free === undefined) throw new Refusal("multi_node_unapproved", `Each multi-node approval for ${req.namespace} is used already; one approval covers one lease.`);
          db.prepare("INSERT INTO approvals_used (approval, lease_id, at) VALUES (?, ?, ?)").run(free, req.id, t);
        }
        // Over every lease ever made on the namespace, in this transaction: never reused, and above every predecessor's.
        const seq = (db.prepare<[string, string], { top: number }>("SELECT COALESCE(MAX(claim_seq), 0) AS top FROM leases WHERE context = ? AND namespace = ?").get(req.context, req.namespace)?.top ?? 0) + 1;
        db.prepare(
          `INSERT INTO leases (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state, reason, mode, request_id, predecessor, claim_seq, trial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 'claimed', ?, ?, ?, ?)`,
        ).run(req.id, req.thread, req.cluster, req.context, req.namespace, req.uid, req.gpuType, req.gpus, req.hours, req.approvals !== null ? 1 : 0, t, wholeSecond(t + req.hours * 3_600_000), req.request, req.replaces, seq, req.trial ? 1 : 0);
        fault?.();
        return { row: mustGet(req.id), outcome: "granted" as const };
      }).immediate();
    },

    /** The latest lease ever made on a namespace, live or ended: what a fresh claim must name as `replaces`. */
    latestOn(context: string, namespace: string): LeaseRow | undefined {
      return q.latestOn.get(context, namespace);
    },

    openAttempts(id: string): AttemptRow[] {
      return q.openAttempts.all(id);
    },

    /** Record a write before it is sent: only by the holder of the lease's live slot, one open attempt at a time. */
    attemptBegin(id: string, thread: string | undefined, token: string, target: AttemptTarget, cfg: Config): { attempt: string; epoch: number } {
      return db.transaction(() => {
        sweepExpired(cfg.graceMs);
        const row = owned(id, thread);
        if (row.state !== "active") throw new Refusal("lease_not_active", `Lease ${id} is ${row.state}.`);
        if (row.op_token !== token || row.op_deadline === null || row.op_deadline <= now()) {
          throw new Refusal("slot_lost", `The slot of lease ${id} is not held by this token; take it again.`);
        }
        const open = q.openAttempts.all(id);
        if (open.length > 0) throw new Refusal("attempt_unresolved", `Lease ${id} already has an unresolved write (${open[0]!.id}).`);
        db.prepare(
          "INSERT INTO attempts (id, lease_id, verb, kind, name, target_uid, target_rv, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(target.attempt, id, target.verb, target.kind, target.name, target.uid, target.rv, now());
        db.prepare("UPDATE leases SET attempt_epoch = attempt_epoch + 1 WHERE id = ?").run(id);
        return { attempt: target.attempt, epoch: mustGet(id).attempt_epoch };
      }).immediate();
    },

    /** The owner's guard reports what a write did. Only an open attempt of this lease changes. */
    attemptResolve(id: string, thread: string | undefined, resolution: Resolution): { resolved: boolean } {
      return db.transaction(() => {
        owned(id, thread);
        return { resolved: resolve(id, [resolution]) === 1 };
      }).immediate();
    },

    /** Resolutions a trusted host's teardown reported. */
    resolveAttempts(id: string, resolutions: readonly Resolution[]): number {
      return db.transaction(() => resolve(id, resolutions)).immediate();
    },

    /**
     * Complete a claimed lease's teardown and return its GPUs, in one transaction, only when every
     * condition holds: it is this exact closing lease and namespace UID; nothing moved its attempt epoch
     * since the teardown read it (no attempt opened or resolved but the ones this result reports); the
     * fence report holds (see `fenceRefusal`); and after those resolutions no attempt is open. The
     * teardown's inventory read came after its own resolution reads and after the drain. Anything else
     * frees nothing, so a stale or replayed result frees zero GPUs. A completion under a retired fence is
     * flagged for the digest in the same transaction.
     */
    completeClaimed(id: string, uid: string, epoch: number, resolutions: readonly Resolution[], report: FenceReport): { completed: boolean; freed: number; why?: string } {
      return db.transaction(() => {
        const refused = (why: string) => ({ completed: false, freed: 0, why });
        const row = q.get.get(id);
        if (row === undefined || row.mode !== "claimed" || row.uid !== uid) return refused("not this claimed lease and namespace");
        if (row.state !== "revoking" && row.state !== "releasing") return refused(`the lease is ${row.state}`);
        if (row.attempt_epoch !== epoch) return refused("the lease changed since this teardown read it");
        const fence = fenceRefusal(row, report);
        if (fence !== null) return refused(fence);
        resolve(id, resolutions);
        if (q.openAttempts.all(id).length > 0) return refused("a write attempt is still open");
        const final: LeaseState = row.state === "releasing" ? "released" : "torn-down";
        db.prepare(
          "UPDATE leases SET state = ?, reason = COALESCE(reason, 'teardown_complete'), ended_at = ?, op_token = NULL, op_deadline = NULL, failures = 0, last_error = NULL WHERE id = ?",
        ).run(final, now(), id);
        if (report.armed === "retired") {
          addFlag(
            id,
            "fence_retired_completion",
            `Lease ${id} (${row.namespace} on ${row.cluster}) completed under a retired fence (proof: ${row.fence_retired_proof}): the namespace is unenrolled and no policy admits its Pods. A late Pod of this lease is caught only by k8s-sweep.`,
          );
        }
        return { completed: true, freed: row.gpus };
      }).immediate();
    },

    /**
     * Record the proof that a claimed lease's fence is retired for good (exit 2). Only for a claimed lease
     * in teardown; the caller has checked it does not come from a thread.
     */
    recordFenceRetired(id: string, proof: string): LeaseRow {
      return db.transaction(() => {
        const row = mustGet(id);
        if (row.mode !== "claimed") throw new Refusal("lease_not_claimed", `Lease ${id} is not a claim of a pre-made namespace; it has no fence.`);
        if (row.state !== "revoking" && row.state !== "releasing") {
          throw new Refusal("lease_not_in_teardown", `Lease ${id} is ${row.state}; a retired fence's proof is for a lease in teardown (revoking or releasing).`);
        }
        db.prepare("UPDATE leases SET fence_retired_proof = ? WHERE id = ?").run(proof, id);
        return mustGet(id);
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

    /** Start teardown, with the grace period from now or from the expiry, whichever ends first. Only an active lease is revoked; one in teardown keeps its deadline. */
    revoke(id: string, reason: string, graceMs: number): LeaseRow {
      return db.transaction(() => {
        // An expired lease keeps the deadline its expiry set, the same one the offline timer uses.
        const t = now();
        db.prepare(
          `UPDATE leases SET state = 'revoking', reason = CASE WHEN expires_at <= ? THEN 'expired' ELSE ? END, revoked_at = ?,
             grace_deadline = MIN(? + ?, expires_at + ?), op_token = NULL, op_deadline = NULL
           WHERE id = ? AND state = 'active'`,
        ).run(t, reason, t, t, graceMs, graceMs, id);
        return mustGet(id);
      }).immediate();
    },

    /** A host saw the namespace gone, or re-created: the lease frees its GPUs. Never a claimed lease: only completeClaimed ends one. */
    end(id: string, why: string): LeaseRow {
      return db.transaction(() => {
        const row = mustGet(id);
        if (!CHARGED.includes(row.state) || row.mode === "claimed") return row;
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

    /** Raise a flag of this kind for this lease once, ever: a cleared one is not raised again. */
    flagOnce(id: string, kind: string, detail: string): void {
      db.transaction(() => {
        const raised = db.prepare<[string, string], { id: number }>("SELECT id FROM flags WHERE lease_id = ? AND kind = ?").get(id, kind);
        if (raised === undefined) addFlag(id, kind, detail);
      }).immediate();
    },

    /** Keep what a host reported, without counting it as a failure. */
    noteReport(id: string, text: string): void {
      db.prepare("UPDATE leases SET last_error = ?, last_checked_at = ? WHERE id = ?").run(text, now(), id);
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

    /** Note the first `down` of a lease, so a deletion that never finishes can be flagged. */
    markDownStarted(id: string): void {
      db.prepare("UPDATE leases SET down_first_at = COALESCE(down_first_at, ?) WHERE id = ?").run(now(), id);
    },

    /** Flag a deletion that has not finished `afterMs` after its first `down`, once per lease. */
    flagIfStuck(id: string, afterMs: number): void {
      db.transaction(() => {
        const row = mustGet(id);
        if (row.down_first_at === null || row.stuck_flagged === 1 || now() - row.down_first_at < afterMs) return;
        db.prepare("UPDATE leases SET stuck_flagged = 1 WHERE id = ?").run(id);
        addFlag(
          id,
          "teardown_failing",
          row.mode === "claimed"
            ? `Lease ${id} (${row.namespace} on ${row.cluster}): its teardown has not completed ${Math.round((now() - row.down_first_at) / 60_000)} min after the first down (an unresolved write, a held pod, or an object that changed hands). Its GPUs stay charged; no timer frees them.`
            : `Lease ${id} (${row.namespace} on ${row.cluster}): its namespace still exists ${Math.round((now() - row.down_first_at) / 60_000)} min after the first delete. Its GPUs stay charged.`,
        );
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

    /** Keep a profile read, unless the kept one comes from a read that started later. `at` is when the read started. */
    saveProfiles(hostId: string, json: string, startedAt: number): void {
      db.prepare(
        `INSERT INTO profiles (id, host_id, at, json) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, at = excluded.at, json = excluded.json WHERE excluded.at >= profiles.at`,
      ).run(hostId, startedAt, json);
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
