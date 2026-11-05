// Fixtures for the server tests: a fake cluster, a fake `k8s-guard` that
// follows the guard contract (lease commands in, inspect/expire/down/extend
// out), and the guard rules the plugin relies on, fake bb threads, and the plugin on bb's fake host.
//
// The fake guard decides its authority the way the real one must: it asks
// the plugin with `bb k8s lease show`, through the plugin's own CLI, and
// falls back to the namespace's `expires-at` only when bb is unreachable.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createK8sLeasesPlugin } from "./server.ts";
import type { Inspect } from "./lib/contract.ts";

export const T0 = Date.parse("2026-11-05T10:00:00Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const THREAD_A = "thr_aaaa1111";
export const THREAD_B = "thr_bbbb2222";
export const HOST_ONE = "host_one";
export const HOST_TWO = "host_two";

/** Made-up clusters; real names never enter the repo. */
export const CLUSTER_A = "test-cluster-a";
export const CLUSTER_B = "test-cluster-b";
export const UNAPPROVED = "test-cluster-new";

export const BASE_SETTINGS = {
  clusters: JSON.stringify({
    [CLUSTER_A]: { gpusPerNode: { gb300: 4, h100: 8 } },
    [CLUSTER_B]: { gpusPerNode: { gb300: 4 } },
    [UNAPPROVED]: { gpusPerNode: { gb300: 4 } },
  }),
  firstRunApprovals: JSON.stringify({ [CLUSTER_A]: "approved in test", [CLUSTER_B]: "approved in test" }),
  hosts: JSON.stringify([HOST_ONE, HOST_TWO]),
};

export class Clock {
  t = T0;
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Pod {
  dgd: string;
  gpus: number;
  terminating: boolean;
}

export interface FakeNamespace {
  cluster: string;
  name: string;
  uid: string;
  thread: string | null;
  expiresAt: string | null;
  gpuType: string;
  dgds: Map<string, number>;
  pods: Pod[];
  deleting: boolean;
}

let uidCounter = 0;
export function newUid(): string {
  uidCounter += 1;
  return `00000000-0000-4000-8000-${String(uidCounter).padStart(12, "0")}`;
}

/** A cluster: namespaces with DGDs (GPUs by spec) and pods (GPUs held). */
export class FakeCluster {
  readonly namespaces = new Map<string, FakeNamespace>();

  key(cluster: string, name: string): string {
    return `${cluster}/${name}`;
  }

  create(cluster: string, name: string, thread: string | null, opts: { gpuType?: string; expiresAt?: string } = {}): FakeNamespace {
    assert.ok(!this.namespaces.has(this.key(cluster, name)), `namespace ${name} exists`);
    const ns: FakeNamespace = {
      cluster,
      name,
      uid: newUid(),
      thread,
      expiresAt: opts.expiresAt ?? null,
      gpuType: opts.gpuType ?? "gb300",
      dgds: new Map(),
      pods: [],
      deleting: false,
    };
    this.namespaces.set(this.key(cluster, name), ns);
    return ns;
  }

  get(cluster: string, name: string): FakeNamespace | undefined {
    return this.namespaces.get(this.key(cluster, name));
  }

  /** A DGD's spec lands: its GPUs count at once, and its pods start. */
  setDgd(ns: FakeNamespace, dgd: string, gpus: number): void {
    ns.dgds.set(dgd, gpus);
    for (const pod of ns.pods) if (pod.dgd === dgd && !pod.terminating) pod.terminating = true;
    if (gpus > 0) ns.pods.push({ dgd, gpus, terminating: false });
  }

  /** Every DGD to 0 replicas; running pods start terminating. */
  scaleToZero(ns: FakeNamespace): void {
    for (const name of ns.dgds.keys()) ns.dgds.set(name, 0);
    for (const pod of ns.pods) pod.terminating = true;
  }

  /** Delete: the namespace terminates, and goes once its pods are gone. */
  delete(ns: FakeNamespace): void {
    ns.deleting = true;
    ns.dgds.clear();
    for (const pod of ns.pods) pod.terminating = true;
  }

  /** Terminating pods finish; deleted namespaces with no pods go. */
  settle(): void {
    for (const [key, ns] of this.namespaces) {
      ns.pods = ns.pods.filter((pod) => !pod.terminating);
      if (ns.deleting && ns.pods.length === 0) this.namespaces.delete(key);
    }
  }

  inspect(ns: FakeNamespace): Inspect {
    const dgd = [...ns.dgds.values()].reduce((a, b) => a + b, 0);
    const pods = ns.pods.reduce((a, pod) => a + pod.gpus, 0);
    return {
      uid: ns.uid,
      thread: ns.thread,
      expires_at: ns.expiresAt,
      dgd_gpus: dgd,
      pod_gpus: pods,
      gpu_type: dgd + pods > 0 ? ns.gpuType : null,
      gpu_pods_left: ns.pods.length,
    };
  }

  allocation(ns: FakeNamespace): number {
    const view = this.inspect(ns);
    return Math.max(view.dgd_gpus, view.pod_gpus);
  }
}

export interface GuardCall {
  hostId: string;
  method: string;
  cluster: string;
  namespace: string;
  uid?: string;
  leaseId?: string;
  outcome: string;
}

type Cli = (argv: string[], threadId?: string) => Promise<{ code: number; json: any }>;

/**
 * The guard. `handle` serves the host entry's contract for the plugin;
 * `apply` and `ownerDown` are the agent side, run from a thread.
 */
export class FakeGuard {
  readonly calls: GuardCall[] = [];
  readonly downHosts = new Set<string>();
  /** What `k8s-check --list` prints on the hosts; null: the hosts cannot read profiles. */
  profiles: unknown = null;
  /** bb unreachable from the guard: authority falls back to the namespace's `expires-at`. */
  bbOffline = false;
  /** The next `down` deletes, then its response is lost. */
  loseNextDownResponse = false;
  /** Every `down` fails before deleting. */
  failDown = false;
  cli: Cli = async () => {
    throw new Error("cli not wired");
  };

  readonly cluster: FakeCluster;
  readonly clock: Clock;
  constructor(cluster: FakeCluster, clock: Clock) {
    this.cluster = cluster;
    this.clock = clock;
  }

  private async authority(method: string, input: { context: string; uid: string; leaseId: string }, ns: FakeNamespace): Promise<string | null> {
    if (ns.uid !== input.uid) return "uid_mismatch";
    if (this.bbOffline) {
      if (method === "extend") return "offline";
      const expires = ns.expiresAt === null ? Number.NaN : Date.parse(ns.expiresAt);
      return Number.isFinite(expires) && expires <= this.clock.now() ? null : "not_expired";
    }
    const shown = await this.cli(["lease", "show", input.leaseId]);
    if (shown.code !== 0) return "lease_unknown";
    const lease = shown.json;
    if (lease.context !== input.context || lease.uid !== input.uid || lease.namespace !== ns.name) return "lease_mismatch";
    if (method === "extend") return lease.state === "active" ? null : "lease_not_active";
    return lease.state === "revoking" || lease.state === "releasing" ? null : "lease_active";
  }

  async handle(method: string, input: any, hostId: string): Promise<unknown> {
    if (this.downHosts.has(hostId)) throw new Error(`host ${hostId} is unreachable`);
    if (method === "probe") return { ok: true, detail: "ok" };
    if (method === "profiles") {
      return this.profiles === null ? { ok: false, code: "profiles_missing", error: "no profiles file" } : { ok: true, value: this.profiles };
    }
    const ns = this.cluster.get(input.context, input.namespace);
    const record = (outcome: string) =>
      this.calls.push({ hostId, method, cluster: input.context, namespace: input.namespace, uid: input.uid, leaseId: input.leaseId, outcome });
    if (ns === undefined) {
      record("not_found");
      return { ok: false, code: "not_found", error: `namespace ${input.namespace} not found` };
    }
    if (method === "inspect") {
      record("ok");
      return { ok: true, value: this.cluster.inspect(ns) };
    }
    const refused = await this.authority(method, input, ns);
    if (refused !== null) {
      record(`refused:${refused}`);
      return { ok: false, code: refused, error: `refused: ${refused}` };
    }
    if (method === "expire") this.cluster.scaleToZero(ns);
    if (method === "extend") {
      const shown = await this.cli(["lease", "show", input.leaseId]);
      ns.expiresAt = shown.json.expires_at;
    }
    if (method === "down") {
      if (this.failDown) {
        record("failed");
        return { ok: false, code: "api_error", error: "the API refused the delete" };
      }
      this.cluster.delete(ns);
      if (this.loseNextDownResponse) {
        this.loseNextDownResponse = false;
        record("lost");
        throw new Error("the response was lost");
      }
    }
    record("ok");
    return { ok: true };
  }

  /**
   * An agent's `k8s-guard apply`: take the slot, check the combined
   * allocation, then land. `land` is returned unrun when `pause` is set,
   * to model a request that stalls after its final check.
   */
  async apply(
    leaseId: string,
    thread: string,
    ns: FakeNamespace,
    dgd: string,
    gpus: number,
    opts: { pause?: boolean } = {},
  ): Promise<{ began: boolean; code?: string; land: () => Promise<void> }> {
    const begin = await this.cli(["lease", "op", "begin", leaseId], thread);
    if (begin.code !== 0) return { began: false, code: begin.json.code, land: async () => undefined };
    const shown = (await this.cli(["lease", "show", leaseId])).json;
    const current = [...ns.dgds.entries()].filter(([name]) => name !== dgd).reduce((a, [, n]) => a + n, 0);
    if (current + gpus > shown.gpus) {
      await this.cli(["lease", "op", "end", leaseId, begin.json.token], thread);
      return { began: true, code: "over_lease", land: async () => undefined };
    }
    const land = async () => {
      // The guard's last check is before the call; the call itself is not fenced.
      this.cluster.setDgd(ns, dgd, gpus);
    };
    if (opts.pause) return { began: true, land };
    if (Date.parse(begin.json.deadline) <= this.clock.now()) {
      return { began: true, code: "slot_lapsed", land: async () => undefined };
    }
    await land();
    const end = await this.cli(["lease", "op", "end", leaseId, begin.json.token], thread);
    if (end.json.state !== "active") this.cluster.scaleToZero(ns);
    return { began: true, land: async () => undefined };
  }

  /** The owner's `k8s-guard down`: release through the plugin, then delete with the UID as precondition. */
  async ownerDown(leaseId: string, thread: string, ns: FakeNamespace): Promise<{ code: number; json: any }> {
    const released = await this.cli(["lease", "release", leaseId], thread);
    if (released.code !== 0) return released;
    const current = this.cluster.get(ns.cluster, ns.name);
    if (current !== undefined && current.uid === ns.uid) this.cluster.delete(current);
    return released;
  }

  /** One run of the offline timer (k8s-sweep --enforce): it reads only `expires-at`. */
  offlineTimerRun(graceMs: number): void {
    for (const ns of this.cluster.namespaces.values()) {
      if (ns.expiresAt === null) continue;
      const expires = Date.parse(ns.expiresAt);
      if (expires > this.clock.now()) continue;
      this.cluster.scaleToZero(ns);
      if (expires + graceMs <= this.clock.now()) this.cluster.delete(ns);
    }
  }

  writes(): GuardCall[] {
    return this.calls.filter((call) => call.method !== "inspect");
  }
}

export type ThreadFate = "live" | "archived" | "deleted" | "missing" | "error";

/** bb's thread lookup, faked: each thread is live unless a test says otherwise. */
export class FakeThreads {
  readonly fates = new Map<string, ThreadFate>();
  get = async ({ threadId }: { threadId: string }) => {
    const fate = this.fates.get(threadId) ?? "live";
    if (fate === "missing") throw Object.assign(new Error("not found"), { status: 404, code: "thread_not_found" });
    if (fate === "error") throw Object.assign(new Error("bb is restarting"), { status: 503 });
    return makeThreadResponse({
      id: threadId,
      archivedAt: fate === "archived" ? T0 : null,
      deletedAt: fate === "deleted" ? T0 : null,
    } as never);
  };
}

export async function setup(settings: Record<string, string | number> = {}) {
  const clock = new Clock();
  const cluster = new FakeCluster();
  const guard = new FakeGuard(cluster, clock);
  const threads = new FakeThreads();
  let ids = 0;
  const factory = createK8sLeasesPlugin({
    now: clock.now,
    newLeaseId: () => `lse_test${String(++ids).padStart(6, "0")}`,
    newToken: () => `tok_${String(++ids).padStart(6, "0")}`,
    // Production ticks only start work; a test tick settles it, bounded so a stalled fake cannot hang the suite.
    tickWaitMs: 2_000,
  });
  const created = createFakePluginHost({
    pluginId: "k8s-leases",
    settings: { ...BASE_SETTINGS, ...settings },
    sdk: { threads: { get: threads.get } as never },
    experimental_callHostRpc: ({ method, input, hostId }) => guard.handle(method, input, hostId),
  });
  await factory(created.bb);
  // A reload hands back a new host; every driver below goes through the current one.
  let current = created;
  const cli: Cli = async (argv, threadId) => {
    const result = await current.harness.behavior.runCli(argv, threadId === undefined ? {} : { threadId });
    let json: any = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = { raw: result.stdout, stderr: result.stderr };
    }
    return { code: result.exitCode, json };
  };
  guard.cli = cli;
  const tick = () => current.harness.behavior.runSchedule("reconcile");

  /** Make a namespace the guard would have made, and take a lease on it. */
  async function lease(
    thread: string,
    name: string,
    gpus: number,
    opts: { cluster?: string; gpuType?: string; hours?: number } = {},
  ): Promise<{ id: string; ns: FakeNamespace; result: { code: number; json: any } }> {
    const clusterName = opts.cluster ?? CLUSTER_A;
    const ns = cluster.get(clusterName, name) ?? cluster.create(clusterName, name, thread, { gpuType: opts.gpuType });
    const result = await acquire(thread, ns, gpus, opts);
    return { id: result.json.lease_id, ns, result };
  }

  function acquire(
    thread: string,
    ns: FakeNamespace,
    gpus: number,
    opts: { gpuType?: string; hours?: number; asThread?: string; uid?: string; clusterName?: string } = {},
  ) {
    return cli(
      [
        "lease",
        "acquire",
        "--cluster",
        opts.clusterName ?? ns.cluster,
        "--namespace",
        ns.name,
        "--uid",
        opts.uid ?? ns.uid,
        "--thread",
        thread,
        "--gpu-type",
        opts.gpuType ?? ns.gpuType,
        "--gpus",
        String(gpus),
        "--hours",
        String(opts.hours ?? 2),
      ],
      opts.asThread ?? thread,
    );
  }

  async function reload() {
    current = await current.harness.lifecycle.reload(factory);
  }

  return {
    get bb() {
      return current.bb;
    },
    get harness() {
      return current.harness;
    },
    clock, cluster, guard, threads, cli, tick, lease, acquire, reload, factory };
}

/** Run ticks, one minute apart, until `done` or `max` ticks. */
export async function ticksUntil(world: Awaited<ReturnType<typeof setup>>, done: () => boolean, max = 10): Promise<number> {
  for (let n = 1; n <= max; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
    if (done()) return n;
  }
  return -1;
}
