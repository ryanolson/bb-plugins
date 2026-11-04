// One reconcile step for one lease, and the host calls behind it.
//
// The server decides; the host entry only runs k8s-guard. A lease ends, and
// frees its GPUs, only when a host reports its namespace gone or re-created.
// A lookup that merely failed changes nothing and is retried next tick.
//
// Every tick runs a step for every live lease, even one whose last step is
// still waiting on a slow host: a step only reads, reduces, or syncs, and it
// re-reads its lease after inspect, so two at once are safe. The host call
// orders a stalled host last, so the new step reaches a healthy one. `down`
// can run for minutes, so it runs on its own lane, once per lease, and a step
// waits for it only briefly. `extend` runs one at a time per lease, so an
// older expiry can never land after a newer one.
import type { GuardFailure, Inspect, WriteMethod } from "./contract.ts";
import type { LeaseRow, Store } from "./store.ts";
import type { Config } from "./settings.ts";

/** What bb says about a lease's thread. Only the first three revoke. */
export type ThreadFate = "archived" | "deleted" | "missing" | "live" | "unknown";

/** No host could be reached, or none gave an answer. */
export class HostUnreachable extends Error {
  readonly attempts: string[];
  constructor(attempts: string[]) {
    super(attempts.length === 0 ? "no enforcement host is configured" : `no enforcement host answered: ${attempts.join("; ")}`);
    this.name = "HostUnreachable";
    this.attempts = attempts;
  }
}

export type HostCall = <M extends "inspect" | WriteMethod>(
  method: M,
  lease: Pick<LeaseRow, "context" | "namespace" | "uid" | "id">,
) => Promise<{ hostId: string; result: M extends "inspect" ? { ok: true; value: Inspect } | GuardFailure : { ok: true } | GuardFailure }>;

export interface EnforcerDeps {
  store: Store;
  config: () => Promise<Config>;
  now: () => number;
  host: HostCall;
  threadFate: (threadId: string) => Promise<ThreadFate>;
  log: (text: string) => void;
  /** How long a step waits for its `down` before it returns and lets the deletion go on alone. */
  downWaitMs: number;
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

export function createEnforcer(deps: EnforcerDeps) {
  const { store, now } = deps;
  /** The `down` in flight for each lease. */
  const deletions = new Map<string, Promise<boolean>>();
  /** Leases whose last `down` failed: a working `expire` does not reset their failure count. */
  const downFailed = new Set<string>();
  /** The `extend` chain of each lease. */
  const extending = new Map<string, Promise<boolean>>();

  function fail(lease: LeaseRow, what: string): void {
    deps.log(`lease ${lease.id}: ${what}`);
    if (store.noteFailure(lease.id, what)) {
      const kind = lease.state === "active" ? "reconcile_failing" : "teardown_failing";
      store.flag(lease.id, kind, `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}, ${lease.state}): ${what}`);
    }
  }

  async function write(method: WriteMethod, lease: LeaseRow): Promise<boolean> {
    try {
      const { result } = await deps.host(method, lease);
      if (result.ok) return true;
      fail(lease, `k8s-guard ${method} failed (${result.code}): ${result.error}`);
    } catch (error) {
      fail(lease, `k8s-guard ${method}: ${message(error)}`);
    }
    return false;
  }

  /** Start the lease's `down`, or null when one is already running. */
  function down(lease: LeaseRow): Promise<boolean> | null {
    if (deletions.has(lease.id)) return null;
    const started = write("down", lease).then((ok) => {
      if (ok) downFailed.delete(lease.id);
      else downFailed.add(lease.id);
      return ok;
    });
    void started.finally(() => deletions.delete(lease.id));
    deletions.set(lease.id, started);
    return started;
  }

  /** Sync the namespace's expires-at to the lease, after any sync already running for it. */
  function extend(lease: LeaseRow): Promise<boolean> {
    const previous = extending.get(lease.id) ?? Promise.resolve(true);
    const next = previous.then(() => write("extend", store.find(lease.id) ?? lease));
    extending.set(lease.id, next);
    void next.finally(() => {
      if (extending.get(lease.id) === next) extending.delete(lease.id);
    });
    return next;
  }

  async function step(id: string): Promise<void> {
    const cfg = await deps.config();
    store.sweepExpired(cfg.graceMs);
    let lease = store.find(id);
    if (lease === undefined || !["active", "revoking", "releasing"].includes(lease.state)) return;
    if (lease.state === "active") {
      const fate = await deps.threadFate(lease.thread_id);
      if (fate === "archived" || fate === "deleted" || fate === "missing") lease = store.revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
    }

    let seen: { hostId: string; result: { ok: true; value: Inspect } | GuardFailure };
    try {
      seen = await deps.host("inspect", lease);
    } catch (error) {
      fail(lease, `inspect: ${message(error)}`);
      return;
    }
    if (!seen.result.ok) {
      if (seen.result.code === "not_found") {
        store.end(id, "namespace_gone");
        return;
      }
      fail(lease, `inspect failed (${seen.result.code}): ${seen.result.error}`);
      return;
    }
    const ns = seen.result.value;
    // A namespace re-created under the same name is a different namespace:
    // the old one is gone, and the new one is never touched.
    if (ns.uid !== lease.uid) {
      store.end(id, "namespace_recreated");
      return;
    }
    const nsExpires = ns.expires_at === null ? null : Date.parse(ns.expires_at);
    store.noteSeen(id, seen.hostId, nsExpires !== null && Number.isFinite(nsExpires) ? nsExpires : null);
    // The lease can change while inspect runs (a release, an expiry): act on what it is now.
    store.sweepExpired(cfg.graceMs);
    lease = store.find(id)!;

    if (lease.state === "active") {
      const allocation = Math.max(ns.dgd_gpus, ns.pod_gpus);
      // GPUs of an unknown type cannot be charged to this lease's type.
      const wrongType = allocation > 0 && ns.gpu_type !== lease.gpu_type;
      if (allocation <= lease.gpus && !wrongType) {
        if (nsExpires === lease.expires_at || (await extend(lease))) store.clearFailures(id);
        return;
      }
      const what = wrongType
        ? `${allocation} GPUs of type ${ns.gpu_type ?? "unknown"} on a ${lease.gpu_type} lease`
        : `${allocation} GPUs on a lease of ${lease.gpus} (DGD specs ${ns.dgd_gpus}, pods ${ns.pod_gpus})`;
      store.flag(lease.id, "over_allocation", `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}): ${what}. Revoked; DGDs scaled to 0.`);
      lease = store.revoke(lease.id, "over_allocation", now() + cfg.graceMs);
    }

    // Not active: scale to 0 on every tick, whatever the deletion is doing,
    // so a write that lands late is undone within one tick.
    let worked = await write("expire", lease);
    const deleteNow = lease.state === "releasing" || (lease.grace_deadline !== null && now() >= lease.grace_deadline);
    if (deleteNow) {
      // Wait only for a deletion this step started; one already running goes on alone.
      const deletion = down(lease);
      if (deletion !== null && (await within(deletion, deps.downWaitMs))) worked = (await deletion) && worked;
    }
    // A deletion still running, or one that failed, keeps the failures counted.
    if (worked && !downFailed.has(id) && !deletions.has(id)) store.clearFailures(id);
  }

  async function run(id: string): Promise<void> {
    try {
      await step(id);
    } catch (error) {
      deps.log(`lease ${id}: reconcile failed: ${message(error)}`);
    }
  }

  return {
    /** Reconcile one lease now. */
    reconcile: run,

    /** Move the namespace's expires-at to the lease's expiry now. True when the guard did it. */
    sync: extend,

    /** Revoke every active lease of a thread bb reports gone, then reconcile them. */
    async threadGone(threadId: string, fate: "archived" | "deleted"): Promise<void> {
      const cfg = await deps.config();
      for (const lease of store.activeOfThread(threadId)) {
        store.revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
        await run(lease.id);
      }
    },
  };
}

export type Enforcer = ReturnType<typeof createEnforcer>;
