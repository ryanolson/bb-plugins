// One reconcile step for one lease.
//
// The server decides; the host entry only runs k8s-guard.
//
// - Teardown does not wait on inspect. A lease that is not active gets
//   `expire` on every step, sent to every healthy host at once (it only
//   reduces, so one success is enough), and `down` once it is due.
// - Inspect goes to every healthy host at once. The first answer that shows
//   an over-allocation revokes the lease. The lease ends, and frees its GPUs,
//   only when at least one host reports its namespace gone or re-created and
//   no answering host still sees it. A host that gives no answer frees nothing.
// - `down` runs once per lease, on one host at a time, on its own lane; a
//   step waits for it only briefly. `extend` runs one at a time per lease.
// - Steps on one lease may overlap. Each reads its lease again before it acts.
// - After the plugin unloads, nothing touches the database.
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
  config: () => Promise<Config>;
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
  /** How long a step waits for a `down` it started before it lets the deletion go on alone. */
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

/** Thrown inside a step once the plugin has unloaded; ends the step quietly. */
class Unloaded extends Error {}

function describe(reply: HostAnswer<{ ok: boolean; code?: string; error?: string }>): string {
  if ("unreachable" in reply) return `${reply.hostId}: ${reply.unreachable}`;
  return reply.result.ok ? `${reply.hostId}: ok` : `${reply.hostId}: ${reply.result.code}: ${reply.result.error}`;
}

export function createEnforcer(deps: EnforcerDeps) {
  const { now } = deps;
  /** The `down` in flight for each lease. */
  const deletions = new Map<string, Promise<boolean>>();
  /** Leases whose last `down` failed: they keep their failures counted until a `down` works. */
  const downFailed = new Set<string>();
  /** The `extend` chain of each lease. */
  const extending = new Map<string, Promise<boolean>>();

  /** The store, only while the plugin is loaded. */
  function db(): Store {
    if (deps.disposed()) throw new Unloaded();
    return deps.store;
  }

  function fail(lease: LeaseRow, what: string): void {
    deps.log(`lease ${lease.id}: ${what}`);
    if (db().noteFailure(lease.id, what)) {
      const kind = lease.state === "active" ? "reconcile_failing" : "teardown_failing";
      db().flag(lease.id, kind, `Lease ${lease.id} (${lease.namespace} on ${lease.cluster}, ${lease.state}): ${what}`);
    }
  }

  /** Observe detached work, so no rejection goes unhandled, before or after unload. */
  function detach(work: Promise<unknown>, what: string): void {
    work.catch((error: unknown) => {
      if (!(error instanceof Unloaded) && !deps.disposed()) deps.log(`${what}: ${message(error)}`);
    });
  }

  async function single(method: "down" | "extend", lease: LeaseRow, cfg: Config): Promise<boolean> {
    try {
      const { result } = await deps.hosts.one<WriteResult>(method, deps.target(lease, cfg, method));
      if (result.ok) return true;
      fail(lease, `k8s-guard ${method} failed (${result.code}): ${result.error}`);
    } catch (error) {
      if (error instanceof Unloaded || deps.disposed()) throw new Unloaded();
      fail(lease, `k8s-guard ${method}: ${message(error)}`);
    }
    return false;
  }

  /** Start the lease's `down`, or null when one is already running. */
  function down(lease: LeaseRow, cfg: Config): Promise<boolean> | null {
    if (deletions.has(lease.id)) return null;
    const started = single("down", lease, cfg).then((ok) => {
      if (ok) downFailed.delete(lease.id);
      else downFailed.add(lease.id);
      deps.changed();
      return ok;
    });
    deletions.set(lease.id, started);
    detach(
      started.finally(() => deletions.delete(lease.id)),
      `lease ${lease.id}: down`,
    );
    return started;
  }

  /** Sync the namespace's expires-at to the lease, after any sync already running for it. */
  function extend(lease: LeaseRow, cfg: Config): Promise<boolean> {
    const previous = extending.get(lease.id) ?? Promise.resolve(true);
    const next = previous.catch(() => false).then(() => single("extend", db().find(lease.id) ?? lease, cfg));
    extending.set(lease.id, next);
    detach(
      next.finally(() => {
        if (extending.get(lease.id) === next) extending.delete(lease.id);
      }),
      `lease ${lease.id}: extend`,
    );
    return next;
  }

  /** Scale to 0 on every healthy host, and delete when due. True when it all worked. */
  async function teardown(lease: LeaseRow, cfg: Config): Promise<boolean> {
    const replies = await deps.hosts.all<WriteResult>("expire", deps.target(lease, cfg, "expire"), lease.id);
    const expired = replies.some((reply) => "result" in reply && reply.result.ok);
    if (!expired) fail(lease, `k8s-guard expire worked on no host: ${replies.map(describe).join("; ") || "no host configured"}`);
    const due = lease.state === "releasing" || (lease.grace_deadline !== null && now() >= lease.grace_deadline);
    let deleted = true;
    if (due) {
      // Wait only for a deletion this step started; one already running goes on alone.
      const deletion = down(lease, cfg);
      deleted = deletion !== null && (await within(deletion, deps.downWaitMs)) && (await deletion);
    }
    return expired && deleted && !downFailed.has(lease.id);
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
    return db().revoke(lease.id, "over_allocation", now() + cfg.graceMs);
  }

  async function step(id: string): Promise<void> {
    const cfg = await deps.config();
    db().sweepExpired(cfg.graceMs);
    let lease = db().find(id);
    if (lease === undefined || !["active", "revoking", "releasing"].includes(lease.state)) return;
    if (lease.state === "active") {
      const fate = await deps.threadFate(lease.thread_id);
      if (fate === "archived" || fate === "deleted" || fate === "missing") lease = db().revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
    }
    const uid = lease.uid;
    // A holder, so the inspect callback can start the teardown and the step can see it.
    const torn: { work: Promise<boolean> | null } = { work: lease.state === "active" ? null : teardown(lease, cfg) };

    const replies = await deps.hosts.all<InspectResult>("inspect", deps.target(lease, cfg, "inspect"), lease.id, (reply) => {
      // Act on the first answer that shows an over-allocation, without waiting for the rest.
      if (deps.disposed() || torn.work !== null || !("result" in reply) || !reply.result.ok || reply.result.value.uid !== uid) return;
      const fresh = db().find(id);
      if (fresh?.state !== "active") return;
      const revoked = overAllocated(fresh, reply.result.value, cfg);
      if (revoked !== null) {
        torn.work = teardown(revoked, cfg);
        deps.changed();
      }
    });

    // Only well-formed answers count; a malformed UID is no answer.
    const answered = replies.filter(
      (reply): reply is { hostId: string; result: InspectResult } =>
        "result" in reply && (reply.result.ok ? UID.safeParse(reply.result.value.uid).success : reply.result.code === "not_found"),
    );
    const sees = answered.filter((reply) => reply.result.ok && reply.result.value.uid === uid);
    const gone = answered.filter((reply) => !reply.result.ok || reply.result.value.uid !== uid);
    if (gone.length > 0 && sees.length === 0) {
      db().end(id, gone.some((reply) => reply.result.ok) ? "namespace_recreated" : "namespace_gone");
      if (torn.work !== null) detach(torn.work, `lease ${id}: teardown`);
      deps.changed();
      return;
    }

    let worked = true;
    if (sees.length === 0) {
      worked = false;
      fail(lease, `inspect: no host saw the namespace: ${replies.map(describe).join("; ") || "no host configured"}`);
    } else {
      const views = sees.map((reply) => ({ hostId: reply.hostId, ns: (reply.result as { ok: true; value: Inspect }).value }));
      const expiries = views.map(({ ns }) => (ns.expires_at === null ? null : Date.parse(ns.expires_at)));
      const first = expiries[0] ?? null;
      db().noteSeen(id, views[0]!.hostId, first !== null && Number.isFinite(first) ? first : null);
      db().sweepExpired(cfg.graceMs);
      const fresh = db().find(id)!;
      if (torn.work === null && fresh.state !== "active") torn.work = teardown(fresh, cfg);
      // Every host that sees the namespace must agree with the lease's expiry.
      if (torn.work === null && expiries.some((at) => at !== fresh.expires_at)) worked = await extend(fresh, cfg);
    }
    if (torn.work !== null) worked = (await torn.work) && worked;
    if (worked) db().clearFailures(id);
    deps.changed();
  }

  async function run(id: string): Promise<void> {
    try {
      await step(id);
    } catch (error) {
      if (error instanceof Unloaded || deps.disposed()) return;
      deps.log(`lease ${id}: reconcile failed: ${message(error)}`);
    }
  }

  return {
    /** Reconcile one lease now. Never rejects. */
    reconcile: run,

    /** Move the namespace's expires-at to the lease's expiry now. True when the guard did it. */
    async sync(lease: LeaseRow): Promise<boolean> {
      try {
        return await extend(lease, await deps.config());
      } catch (error) {
        if (error instanceof Unloaded) return false;
        throw error;
      }
    },

    /** Revoke every active lease of a thread bb reports gone, then reconcile them. */
    async threadGone(threadId: string, fate: "archived" | "deleted"): Promise<void> {
      const cfg = await deps.config();
      for (const lease of db().activeOfThread(threadId)) {
        db().revoke(lease.id, `thread_${fate}`, now() + cfg.graceMs);
        await run(lease.id);
      }
    },
  };
}

export type Enforcer = ReturnType<typeof createEnforcer>;
