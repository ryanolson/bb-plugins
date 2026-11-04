// One reconcile step for one lease, and the host calls behind it.
//
// The server decides; the host entry only runs k8s-guard. A lease ends, and
// frees its GPUs, only when a host reports its namespace gone or re-created.
// A lookup that merely failed changes nothing and is retried next tick.
import type { GuardFailure, Inspect, WriteMethod } from "./contract.ts";
import type { LeaseRow, Store } from "./store.ts";
import type { Config } from "./settings.ts";

/** What bb says about a lease's thread. Only the first three revoke. */
export type ThreadFate = "archived" | "deleted" | "missing" | "live" | "unknown";

/** A host that could not be reached; the next host is tried. */
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createEnforcer(deps: EnforcerDeps) {
  const { store, now } = deps;
  /** Leases being reconciled now, so a release and a tick never overlap on one lease. */
  const busy = new Set<string>();

  function fail(lease: LeaseRow, what: string): void {
    deps.log(`lease ${lease.id}: ${what}`);
    if (store.noteFailure(lease.id, what)) {
      const kind = lease.state === "active" ? "reconcile_failing" : "teardown_failing";
      store.flag(lease.id, kind, `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}, ${lease.state}): ${what}`);
    }
  }

  /** Revoke an active lease whose thread is gone. */
  async function checkThread(lease: LeaseRow, cfg: Config): Promise<LeaseRow> {
    if (lease.state !== "active") return lease;
    const fate = await deps.threadFate(lease.thread_id);
    if (fate === "archived" || fate === "deleted" || fate === "missing") {
      return store.revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
    }
    return lease;
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

  async function step(id: string): Promise<LeaseRow | undefined> {
    const cfg = await deps.config();
    store.sweepExpired(cfg.graceMs);
    let lease = store.find(id);
    if (lease === undefined || !["active", "revoking", "releasing"].includes(lease.state)) return lease;
    lease = await checkThread(lease, cfg);

    let seen: { hostId: string; result: { ok: true; value: Inspect } | GuardFailure };
    try {
      seen = await deps.host("inspect", lease);
    } catch (error) {
      fail(lease, `inspect: ${message(error)}`);
      return store.find(id);
    }
    const { result } = seen;
    if (!result.ok) {
      if (result.code === "not_found") return store.end(id, "namespace_gone");
      fail(lease, `inspect failed (${result.code}): ${result.error}`);
      return store.find(id);
    }
    const ns = result.value;
    // A namespace re-created under the same name is a different namespace:
    // the old one is gone, and the new one is never touched.
    if (ns.uid !== lease.uid) return store.end(id, "namespace_recreated");
    const nsExpires = ns.expires_at === null ? null : Date.parse(ns.expires_at);
    store.noteSeen(id, seen.hostId, nsExpires !== null && Number.isFinite(nsExpires) ? nsExpires : null);

    if (lease.state === "active") {
      const allocation = Math.max(ns.dgd_gpus, ns.pod_gpus);
      const wrongType = allocation > 0 && ns.gpu_type !== null && ns.gpu_type !== lease.gpu_type;
      if (allocation > lease.gpus || wrongType) {
        const what = wrongType
          ? `${allocation} ${ns.gpu_type} GPUs on a ${lease.gpu_type} lease`
          : `${allocation} GPUs on a lease of ${lease.gpus} (DGD specs ${ns.dgd_gpus}, pods ${ns.pod_gpus})`;
        store.flag(lease.id, "over_allocation", `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}): ${what}. Revoked; DGDs scaled to 0.`);
        lease = store.revoke(lease.id, "over_allocation", now() + cfg.graceMs);
      } else {
        if (nsExpires === lease.expires_at || (await write("extend", lease))) store.clearFailures(id);
        return store.find(id);
      }
    }

    let worked = true;
    if (lease.state === "revoking") {
      // Every tick, so a write that lands after revocation is undone within one.
      worked = await write("expire", lease);
      if (lease.grace_deadline !== null && now() >= lease.grace_deadline) worked = (await write("down", lease)) && worked;
    } else if (lease.state === "releasing") {
      worked = await write("down", lease);
    }
    if (worked) store.clearFailures(id);
    return store.find(id);
  }

  return {
    /** Reconcile one lease, unless it is being reconciled already. */
    async reconcile(id: string): Promise<LeaseRow | undefined> {
      if (busy.has(id)) return store.find(id);
      busy.add(id);
      try {
        return await step(id);
      } finally {
        busy.delete(id);
      }
    },

    /** Move the namespace's expires-at to the lease's expiry now. True when the guard did it. */
    async sync(lease: LeaseRow): Promise<boolean> {
      return write("extend", lease);
    },

    /** Revoke every active lease of a thread bb reports gone, then reconcile them. */
    async threadGone(threadId: string, fate: "archived" | "deleted"): Promise<void> {
      const cfg = await deps.config();
      for (const lease of store.activeOfThread(threadId)) {
        store.revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
        await this.reconcile(lease.id);
      }
    },
  };
}

export type Enforcer = ReturnType<typeof createEnforcer>;
