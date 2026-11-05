// What each tick does for each lease.
//
// The server decides; the host entry only runs k8s-guard. A tick reads the
// lease table and starts three independent parts per lease, awaiting nothing
// before it starts them:
//
// - Teardown, for a lease that is not active: a fresh `expire` to every
//   healthy host at once (it only reduces, so one success is enough), and,
//   when due, `down`, started at the same moment, not after `expire`.
// - Observe: a fresh `inspect` to every healthy host at once. The first answer
//   that shows an over-allocation revokes the lease and starts its teardown.
//   The lease ends, and frees its GPUs, only when at least one host reports
//   its namespace gone or re-created, no answering host still sees it, the
//   report comes from a call that started after the last sighting came back,
//   and no other inspect of the lease is still running. A host that gives no
//   answer frees nothing.
// - Thread check, for an active lease: bb's thread lookup, with its own
//   timeout. Only when it finishes does it revoke a lease whose thread is gone.
//
// `down` runs once per lease, on one host at a time, on its own lane.
// `extend` runs one at a time per lease. After the plugin unloads, nothing
// touches the database, and every promise has a handler from the start.
import { UID, type GuardFailure, type Inspect } from "./contract.ts";
import type { HostAnswer, Hosts } from "./hosts.ts";
import type { LeaseRow, Store } from "./store.ts";
import type { Config } from "./settings.ts";

/** What bb says about a lease's thread. Only the first three revoke. */
export type ThreadFate = "archived" | "deleted" | "missing" | "live" | "unknown";

export type GuardMethod = "inspect" | "expire" | "down" | "extend";
type InspectResult = { ok: true; value: Inspect } | GuardFailure;
type WriteResult = { ok: true } | GuardFailure;

export interface EnforcerDeps {
  store: Store;
  now: () => number;
  hosts: Hosts<GuardMethod>;
  /** The host entry's input for a guard call on this lease. */
  target: (lease: LeaseRow, cfg: Config, method: GuardMethod) => unknown;
  threadFate: (threadId: string) => Promise<ThreadFate>;
  log: (text: string) => void;
  /** The lease table changed. */
  changed: () => void;
  /** True once the plugin has unloaded. */
  disposed: () => boolean;
  /** How long the thread check may take; past it the thread counts as unknown. */
  threadCheckMs: number;
  /** A namespace still there this long after its first `down` is flagged. */
  stuckMs: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait for `work` at most `ms`; true when it settled in time. */
export async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown once the plugin has unloaded; ends the work quietly. */
class Unloaded extends Error {}

function describe(reply: HostAnswer<{ ok: boolean; code?: string; error?: string }>): string {
  if ("unreachable" in reply) return `${reply.hostId}: ${reply.unreachable}`;
  return reply.result.ok ? `${reply.hostId}: ok` : `${reply.hostId}: ${reply.result.code}: ${reply.result.error}`;
}

const LIVE = ["active", "revoking", "releasing"];

export function createEnforcer(deps: EnforcerDeps) {
  const { now } = deps;
  /** The `down` in flight for each lease. */
  const deletions = new Map<string, Promise<boolean>>();
  /** The `extend` chain of each lease. */
  const extending = new Map<string, Promise<boolean>>();
  /** The thread check in flight for each lease. */
  const threadChecks = new Map<string, Promise<void>>();
  /** When the latest reply that saw each lease's namespace came back, on the hosts' call counter. */
  const lastSeen = new Map<string, number>();
  /** Inspect fan-outs still running, by lease. */
  const inspecting = new Map<string, number>();

  /** The store, only while the plugin is loaded. */
  function db(): Store {
    if (deps.disposed()) throw new Unloaded();
    return deps.store;
  }

  /** Give a promise a handler now, so it can never reject unobserved; return it for whoever awaits it. */
  function observed<T>(work: Promise<T>, what: string): Promise<T> {
    work.catch((error: unknown) => {
      if (!(error instanceof Unloaded) && !deps.disposed()) deps.log(`${what}: ${message(error)}`);
    });
    return work;
  }

  function fail(lease: LeaseRow, what: string): void {
    deps.log(`lease ${lease.id}: ${what}`);
    if (db().noteFailure(lease.id, what)) {
      const kind = lease.state === "active" ? "reconcile_failing" : "teardown_failing";
      db().flag(lease.id, kind, `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}, ${lease.state}): ${what}`);
    }
  }

  /**
   * A teardown found the namespace re-created (`uid_mismatch`): a sighting,
   * kept and flagged once for the digest. It never frees the GPUs on its own;
   * only inspect's merge rule does.
   */
  function recreated(lease: LeaseRow, what: string): void {
    db().noteReport(lease.id, what);
    db().flagOnce(lease.id, "namespace_recreated", `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}): ${what}. Its GPUs stay charged until inspect confirms the old namespace is gone.`);
  }

  async function single(method: "down" | "extend", lease: LeaseRow, cfg: Config): Promise<boolean> {
    let reply;
    try {
      reply = await deps.hosts.one<WriteResult>(method, deps.target(lease, cfg, method));
    } catch (error) {
      if (deps.disposed()) throw new Unloaded();
      fail(lease, `k8s-guard ${method}: ${message(error)}`);
      return false;
    }
    if (reply.result.ok) return true;
    const { code, error } = reply.result;
    if (code === "pods_left") {
      // Not a failure: the deletion goes on, and down runs again next tick. A stuck one is flagged by time.
      db().noteReport(lease.id, `k8s-guard ${method}: ${code}: ${error}`);
    } else if (code === "uid_mismatch") {
      recreated(lease, `k8s-guard ${method}: ${error}`);
    } else if (code === "lease_record_missing") {
      // The namespace has no lease record: acquire failed after the grant. Only a release puts it right.
      db().noteReport(lease.id, `k8s-guard ${method}: ${error}`);
      db().flagOnce(
        lease.id,
        "lease_record_missing",
        `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}): the namespace has no lease record, so its expires-at cannot follow the lease. Release it with \`bb k8s lease release ${lease.id}\`, which tears the namespace down.`,
      );
    } else {
      fail(lease, `k8s-guard ${method} failed (${code}): ${error}`);
    }
    return false;
  }

  /** Start the lease's `down`, unless one is already running. */
  function down(lease: LeaseRow, cfg: Config): Promise<boolean> {
    const running = deletions.get(lease.id);
    if (running !== undefined) return running;
    db().markDownStarted(lease.id);
    const started = observed(
      single("down", lease, cfg).finally(() => {
        deletions.delete(lease.id);
        if (!deps.disposed()) deps.changed();
      }),
      `lease ${lease.id}: down`,
    );
    deletions.set(lease.id, started);
    return started;
  }

  /** Sync the namespace's expires-at to the lease, after any sync already running for it. */
  function extend(lease: LeaseRow, cfg: Config): Promise<boolean> {
    const previous = extending.get(lease.id) ?? Promise.resolve(true);
    const next = observed(
      previous.catch(() => false).then(() => single("extend", db().find(lease.id) ?? lease, cfg)),
      `lease ${lease.id}: extend`,
    );
    extending.set(lease.id, next);
    void next.finally(() => {
      if (extending.get(lease.id) === next) extending.delete(lease.id);
    }).catch(() => undefined);
    return next;
  }

  /** Scale to 0 on every healthy host and, when due, delete, both started now. */
  function teardown(lease: LeaseRow, cfg: Config): Promise<void> {
    const due = lease.state === "releasing" || (lease.grace_deadline !== null && now() >= lease.grace_deadline);
    const deletion = due ? down(lease, cfg) : null;
    const expiring = deps.hosts.all<WriteResult>("expire", deps.target(lease, cfg, "expire")).then((replies) => {
      const isRecreated = (reply: (typeof replies)[number]) => "result" in reply && !reply.result.ok && reply.result.code === "uid_mismatch";
      // Any host that saw a re-created namespace is a sighting, even when another host's expire worked. Only inspect frees the GPUs.
      if (replies.some(isRecreated)) recreated(lease, "k8s-guard expire: a host saw a re-created namespace");
      if (replies.some((reply) => "result" in reply && reply.result.ok)) return true;
      // Every host saw it: nothing of this lease is left to scale, so it is no failure.
      if (!(replies.length > 0 && replies.every(isRecreated))) fail(lease, `k8s-guard expire worked on no host: ${replies.map(describe).join("; ") || "no host configured"}`);
      return false;
    });
    return observed(
      Promise.all([expiring, deletion ?? Promise.resolve(true)]).then(([expired, deleted]) => {
        if (expired && deleted) db().clearFailures(lease.id);
      }),
      `lease ${lease.id}: teardown`,
    );
  }

  /** Revoke for an over-allocation, or null when the namespace fits its lease. */
  function overAllocated(lease: LeaseRow, ns: Inspect, cfg: Config): LeaseRow | null {
    const allocation = Math.max(ns.dgd_gpus, ns.pod_gpus);
    // GPUs of an unknown type cannot be charged to this lease's type.
    const wrongType = allocation > 0 && ns.gpu_type !== lease.gpu_type;
    if (allocation <= lease.gpus && !wrongType) return null;
    const what = wrongType
      ? `${allocation} GPUs of type ${ns.gpu_type ?? "unknown"} on a ${lease.gpu_type} lease`
      : `${allocation} GPUs on a lease of ${lease.gpus} (DGD specs ${ns.dgd_gpus}, pods ${ns.pod_gpus})`;
    db().flag(lease.id, "over_allocation", `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}): ${what}. Revoked; DGDs scaled to 0.`);
    return db().revoke(lease.id, "over_allocation", cfg.graceMs);
  }

  async function observe(lease: LeaseRow, cfg: Config): Promise<void> {
    const id = lease.id;
    const uid = lease.uid;
    let revokedHere = false;
    inspecting.set(id, (inspecting.get(id) ?? 0) + 1);
    const replies = await deps.hosts
      .all<InspectResult>("inspect", deps.target(lease, cfg, "inspect"), (reply) => {
        if (deps.disposed() || !("result" in reply) || !reply.result.ok || reply.result.value.uid !== uid) return;
        lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, reply.done));
        // Act on the first answer that shows an over-allocation, without waiting for the rest.
        const fresh = db().find(id);
        if (fresh?.state !== "active" || revokedHere) return;
        const revoked = overAllocated(fresh, reply.result.value, cfg);
        if (revoked !== null) {
          revokedHere = true;
          void teardown(revoked, cfg);
          deps.changed();
        }
      })
      .finally(() => inspecting.set(id, (inspecting.get(id) ?? 1) - 1));

    // Only well-formed answers count; a malformed UID is no answer.
    const answered = replies.filter(
      (reply): reply is { hostId: string; seq: number; done: number; result: InspectResult } =>
        "result" in reply && (reply.result.ok ? UID.safeParse(reply.result.value.uid).success : reply.result.code === "not_found"),
    );
    const sees = answered.filter((reply) => reply.result.ok && reply.result.value.uid === uid);
    // A report of "gone" counts only if its call started after the last sighting came back,
    // and only when no other inspect of this lease is still out: its answer could still see it.
    const seenAt = lastSeen.get(id) ?? 0;
    const gone = answered.filter((reply) => (!reply.result.ok || reply.result.value.uid !== uid) && reply.seq > seenAt);
    if (sees.length === 0 && gone.length > 0 && (inspecting.get(id) ?? 0) === 0) {
      db().end(id, gone.some((reply) => reply.result.ok) ? "namespace_recreated" : "namespace_gone");
      lastSeen.delete(id);
      deps.changed();
      return;
    }
    if (sees.length === 0) {
      if (answered.length === 0) fail(lease, `inspect: no host answered: ${replies.map(describe).join("; ") || "no host configured"}`);
      return;
    }
    const views = sees.map((reply) => (reply.result as { ok: true; value: Inspect }).value);
    const expiries = views.map((ns) => (ns.expires_at === null ? null : Date.parse(ns.expires_at)));
    const first = expiries[0] ?? null;
    db().noteSeen(id, sees[0]!.hostId, first !== null && Number.isFinite(first) ? first : null);
    db().sweepExpired(cfg.graceMs);
    const fresh = db().find(id)!;
    if (fresh.state !== "active") return;
    // Every host that sees the namespace must agree with the lease's expiry.
    const synced = !expiries.some((at) => at !== fresh.expires_at) || (await extend(fresh, cfg));
    if (synced && !revokedHere) db().clearFailures(id);
  }

  /** bb's thread lookup, with its own timeout; revokes only when it finishes. */
  function checkThread(lease: LeaseRow, cfg: Config): Promise<void> {
    const running = threadChecks.get(lease.id);
    if (running !== undefined) return running;
    const lookup = observed(deps.threadFate(lease.thread_id), `lease ${lease.id}: thread lookup`);
    const check = observed(
      (async () => {
        let fate: ThreadFate = "unknown";
        if (await within(lookup, deps.threadCheckMs)) fate = await lookup;
        if (fate !== "archived" && fate !== "deleted" && fate !== "missing") return;
        const fresh = db().find(lease.id);
        if (fresh?.state !== "active") return;
        await teardown(db().revoke(lease.id, `thread_${fate}`, cfg.graceMs), cfg);
        deps.changed();
      })().finally(() => threadChecks.delete(lease.id)),
      `lease ${lease.id}: thread check`,
    );
    threadChecks.set(lease.id, check);
    return check;
  }

  /**
   * Start the work for one lease, awaiting nothing first. The promise settles
   * when all of it has; it never rejects.
   */
  function dispatch(id: string, cfg: Config): Promise<void> {
    const parts: Promise<unknown>[] = [];
    try {
      db().sweepExpired(cfg.graceMs);
      const lease = db().find(id);
      if (lease === undefined || !LIVE.includes(lease.state)) return Promise.resolve();
      if (lease.state !== "active") {
        // Time-based, so it holds whether or not inspect gets an answer.
        db().flagIfStuck(id, deps.stuckMs);
        parts.push(teardown(lease, cfg));
      }
      parts.push(observed(observe(lease, cfg), `lease ${id}: observe`));
      if (lease.state === "active") parts.push(checkThread(lease, cfg));
    } catch (error) {
      if (!(error instanceof Unloaded) && !deps.disposed()) deps.log(`lease ${id}: dispatch failed: ${message(error)}`);
    }
    return Promise.allSettled(parts).then(() => undefined);
  }

  return {
    dispatch,

    /** Move the namespace's expires-at to the lease's expiry now. True when the guard did it. */
    async sync(lease: LeaseRow, cfg: Config): Promise<boolean> {
      try {
        return await extend(lease, cfg);
      } catch (error) {
        if (error instanceof Unloaded) return false;
        throw error;
      }
    },

    /** Revoke every active lease of a thread bb reports gone, then start its teardown. */
    threadGone(threadId: string, fate: "archived" | "deleted", cfg: Config): Promise<void> {
      const work = db()
        .activeOfThread(threadId)
        .map((lease) => dispatch(db().revoke(lease.id, `thread_${fate}`, cfg.graceMs).id, cfg));
      return Promise.all(work).then(() => undefined);
    },
  };
}

export type Enforcer = ReturnType<typeof createEnforcer>;
