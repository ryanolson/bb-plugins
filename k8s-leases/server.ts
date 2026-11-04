// k8s Leases: GPU leases by type on our k8s clusters, fenced writes, and
// the teardown of every lease that expires, is returned, or loses its
// thread.
//
// The server holds the lease table in SQLite and decides. The host entry,
// on each enforcement host, runs k8s-guard when the server asks. A schedule
// reconciles every lease each minute; that, not the op slot, is what bounds
// a late write.
import { randomBytes, randomUUID } from "node:crypto";
import { cliCommand, defineCli, experimental_PluginRpcRefusal, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CHANNEL,
  CLUSTER,
  GPU_TYPE,
  HOST_CALL_MARGIN_MS,
  HOST_TIMEOUTS,
  LEASE_ID,
  NAMESPACE,
  THREAD_ID,
  PROFILES,
  UID,
  hostContract,
  rpcContract,
  type LeaseView,
  type Profiles,
  type Snapshot,
} from "./lib/contract.ts";
import { HostUnreachable, createEnforcer, within, type HostCall, type ThreadFate } from "./lib/enforcer.ts";
import { checkAsk } from "./lib/policy.ts";
import { Refusal } from "./lib/refusal.ts";
import { SETTINGS, parseConfig, type Config } from "./lib/settings.ts";
import { MIGRATIONS, createStore, type LeaseRow } from "./lib/store.ts";

/** `acquire` refuses unless some host sent a heartbeat this recently. */
export const HEARTBEAT_WINDOW_MS = 10 * 60_000;
/** The op slot's deadline. */
export const SLOT_MS = 2 * 60_000;
/** A tick waits this long for its work; the rest goes on, and the next tick skips what is still running. */
const TICK_WAIT_MS = 45_000;
/** A host call running this long marks its host stalled, and the next call tries the other hosts first. */
const STALL_MS = 30_000;
/** A reconcile step waits this long for a `down`; the deletion goes on alone after that. */
const DOWN_WAIT_MS = 20_000;

export interface K8sLeasesOptions {
  now?: () => number;
  newLeaseId?: () => string;
  newToken?: () => string;
  tickWaitMs?: number;
  downWaitMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** A lease as `bb k8s lease show` prints it: the contract's fields, then extras. */
function showJson(row: LeaseRow) {
  return {
    lease_id: row.id,
    state: row.state,
    cluster: row.cluster,
    context: row.context,
    namespace: row.namespace,
    uid: row.uid,
    thread: row.thread_id,
    gpu_type: row.gpu_type,
    gpus: row.gpus,
    expires_at: iso(row.expires_at),
    multi_node: row.multi_node === 1,
    renewals: row.renewals,
    reason: row.reason,
    grace_deadline: iso(row.grace_deadline),
  };
}

const REASONS: Record<string, string> = {
  expired: "it expired",
  released: "its thread returned it",
  over_allocation: "it held more GPUs than it leased",
  thread_archived: "its thread was archived",
  thread_deleted: "its thread was deleted",
  thread_missing: "bb no longer knows its thread",
  namespace_gone: "its namespace is gone",
  namespace_recreated: "its namespace was re-created",
};

/** Why the panel offers no Extend, or null when it does. */
function extendBlocked(row: LeaseRow): string | null {
  if (row.state === "active") return null;
  const why = row.reason === "expired" ? `it expired at ${iso(row.expires_at)}` : (REASONS[row.reason ?? ""] ?? row.reason ?? "it ended");
  if (row.state === "revoking") return `Revoking: ${why}. Deletion at ${iso(row.grace_deadline)}.`;
  if (row.state === "releasing") return `Releasing: ${why}.`;
  return `Ended (${row.state}): ${why}.`;
}

/** Run a command and print its JSON; a refusal exits 1 with `{"error", "code"}` on stdout, as the contract asks. */
async function json(work: () => Promise<unknown> | unknown): Promise<PluginCliResult> {
  try {
    return { exitCode: 0, stdout: `${JSON.stringify(await work())}\n` };
  } catch (error) {
    const body = error instanceof Refusal ? error.toJSON() : { error: message(error), code: "internal" };
    return { exitCode: 1, stdout: `${JSON.stringify(body)}\n`, stderr: `${body.error}\n` };
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, flag: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Refusal("invalid_argument", `${flag}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

function table(rows: LeaseRow[], now: number): string {
  if (rows.length === 0) return "No leases.\n";
  const left = (row: LeaseRow) => {
    if (row.state === "active") return `${Math.max(0, Math.round((row.expires_at - now) / 60_000))} min left`;
    if (row.state === "revoking" && row.grace_deadline !== null) return `deletion in ${Math.max(0, Math.round((row.grace_deadline - now) / 60_000))} min`;
    return "";
  };
  const lines = rows.map((r) => [r.id, r.state, r.cluster, r.namespace, `${r.gpus} ${r.gpu_type}`, r.thread_id, left(r)]);
  const head = ["LEASE", "STATE", "CLUSTER", "NAMESPACE", "GPUS", "THREAD", "TIME"];
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  return [head, ...lines].map((l) => l.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n") + "\n";
}

export function createK8sLeasesPlugin(options: K8sLeasesOptions = {}) {
  const now = options.now ?? Date.now;
  const newLeaseId = options.newLeaseId ?? (() => `lse_${randomBytes(8).toString("hex")}`);
  const newToken = options.newToken ?? (() => `tok_${randomUUID()}`);
  const tickWaitMs = options.tickWaitMs ?? TICK_WAIT_MS;
  const downWaitMs = options.downWaitMs ?? DOWN_WAIT_MS;

  return async function k8sLeases(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(SETTINGS);
    const config = async (): Promise<Config> => parseConfig(await settings.get());

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = createStore(db, now);
    const host = bb.hosts.experimental_client({ contract: hostContract });

    const publish = () => bb.realtime.publish(CHANNEL, { at: now() });

    /** Start times of the host calls in flight, by host. */
    const inFlight = new Map<string, Set<{ start: number }>>();

    /** Whether a host has a call that has run past `STALL_MS`: it is tried last. */
    function stalled(hostId: string): boolean {
      const since = now() - STALL_MS;
      return [...(inFlight.get(hostId) ?? [])].some((call) => call.start <= since);
    }

    /** Track one host call, so a host that hangs is tried last by the next one. */
    async function tracked<T>(hostId: string, call: () => Promise<T>): Promise<T> {
      const entry = { start: now() };
      const calls = inFlight.get(hostId) ?? new Set<{ start: number }>();
      inFlight.set(hostId, calls);
      calls.add(entry);
      try {
        return await call();
      } finally {
        calls.delete(entry);
      }
    }

    /** Hosts in the order to try: not stalled first, then freshest heartbeat, then the settings' order. */
    function hostOrder(cfg: Config): string[] {
      const seen = new Map(store.heartbeats().map((row) => [row.host_id, row.last_ok_at ?? -1]));
      return [...cfg.hosts].sort((a, b) => Number(stalled(a)) - Number(stalled(b)) || (seen.get(b) ?? -1) - (seen.get(a) ?? -1));
    }

    /**
     * Call the host entry, failing over to the next host when one cannot be
     * reached or its guard fails: a host whose own Kubernetes access broke
     * must not stop a healthy one. Only `not_found` is taken as the answer at
     * once. When every host fails, the first guard failure is returned.
     */
    const hostCall: HostCall = async (method, lease) => {
      const cfg = await config();
      const attempts: string[] = [];
      let firstFailure: { hostId: string; result: unknown } | null = null;
      for (const hostId of hostOrder(cfg)) {
        try {
          const input = { run: cfg.run, context: lease.context, namespace: lease.namespace, uid: lease.uid, leaseId: lease.id };
          const result = await tracked(hostId, (): Promise<{ ok: true } | { ok: false; code: string; error: string }> =>
            method === "inspect"
              ? host.call("inspect", { run: cfg.run, context: lease.context, namespace: lease.namespace }, { hostId, timeoutMs: HOST_TIMEOUTS.inspect + HOST_CALL_MARGIN_MS })
              : host.call(method, input, { hostId, timeoutMs: HOST_TIMEOUTS[method] + HOST_CALL_MARGIN_MS }),
          );
          if (!result.ok && result.code !== "not_found") {
            attempts.push(`${hostId}: ${result.code}: ${result.error}`);
            firstFailure ??= { hostId, result };
            continue;
          }
          return { hostId, result } as never;
        } catch (error) {
          attempts.push(`${hostId}: ${message(error)}`);
        }
      }
      if (firstFailure !== null) {
        if (attempts.length > 1) bb.log.warn(`k8s-guard ${method} on ${lease.namespace} failed on every host: ${attempts.join("; ")}`);
        return firstFailure as never;
      }
      throw new HostUnreachable(attempts);
    };

    /**
     * Whether a lease's thread is gone for good: archived, deleted, or
     * unknown to bb (HTTP 404, `thread_not_found`). Any other failure says
     * nothing about the thread.
     */
    async function threadFate(threadId: string): Promise<ThreadFate> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt) return "deleted";
        if (thread.archivedAt) return "archived";
        return "live";
      } catch (error) {
        const failure = error as { status?: unknown; code?: unknown };
        return failure.status === 404 || failure.code === "thread_not_found" ? "missing" : "unknown";
      }
    }

    /** Read the cluster profiles from the first host that can; keep the last good copy. */
    async function refreshProfiles(cfg: Config): Promise<Profiles | null> {
      for (const hostId of hostOrder(cfg)) {
        try {
          const read = await tracked(hostId, () => host.call("profiles", { command: cfg.profilesCommand }, { hostId, timeoutMs: HOST_TIMEOUTS.profiles + HOST_CALL_MARGIN_MS }));
          if (read.ok) {
            store.saveProfiles(hostId, JSON.stringify(read.value));
            return read.value;
          }
          bb.log.warn(`profiles on ${hostId}: ${read.code}: ${read.error}`);
        } catch (error) {
          bb.log.warn(`profiles on ${hostId}: ${message(error)}`);
        }
      }
      return null;
    }

    /** Profiles read within the heartbeat window, or null: then the fallback clusters setting applies. */
    function currentProfiles(): Profiles | null {
      const saved = store.profiles();
      if (saved === undefined || saved.at <= now() - HEARTBEAT_WINDOW_MS) return null;
      const parsed = PROFILES.safeParse(JSON.parse(saved.json));
      return parsed.success ? parsed.data : null;
    }

    const enforcer = createEnforcer({ store, config, now, host: hostCall, threadFate, log: (text) => bb.log.warn(text), downWaitMs });

    /** Probes in flight, by host, so a hung host is not probed twice at once. */
    const probing = new Set<string>();

    /**
     * One tick. Reconciliation starts at once, beside the probes and the
     * profile read, never after them. Each lease's step runs on its own, and
     * the tick waits for all of it at most `tickWaitMs`. So no slow host,
     * lease or probe delays enforcement past the next tick.
     */
    async function tick(): Promise<void> {
      const cfg = await config();
      store.sweepExpired(cfg.graceMs);
      const steps = store.live().map((row) => enforcer.reconcile(row.id));
      const probes = cfg.hosts
        .filter((hostId) => !probing.has(hostId))
        .map(async (hostId) => {
          probing.add(hostId);
          try {
            const probe = await tracked(hostId, () => host.call("probe", { run: cfg.run }, { hostId, timeoutMs: HOST_TIMEOUTS.probe + HOST_CALL_MARGIN_MS }));
            store.heartbeat(hostId, probe.ok, probe.detail);
          } catch (error) {
            store.heartbeat(hostId, false, message(error));
          } finally {
            probing.delete(hostId);
          }
        });
      await within(Promise.all([...steps, ...probes, refreshProfiles(cfg)]), tickWaitMs);
      publish();
    }

    async function acquire(input: Record<string, unknown>, ctx: PluginCliContext) {
      const thread = parsed(THREAD_ID, input.thread, "--thread");
      if (ctx.threadId !== thread) {
        throw new Refusal("not_your_thread", `--thread ${thread} is not the calling thread (${ctx.threadId ?? "none"}).`);
      }
      const cluster = parsed(CLUSTER, input.cluster, "--cluster");
      const namespace = parsed(NAMESPACE, input.namespace, "--namespace");
      const uid = parsed(UID, input.uid, "--uid");
      const gpuType = parsed(GPU_TYPE, input.gpuType, "--gpu-type");
      const gpus = parsed(z.number().int().min(1), input.gpus, "--gpus");
      const hours = parsed(z.coerce.number().positive().finite(), input.hours, "--hours");
      const cfg = await config();
      const { context, approvals } = checkAsk({ thread, cluster, namespace, gpuType, gpus, hours }, cfg, currentProfiles() ?? (await refreshProfiles(cfg)));
      // Cheap checks first; the transaction checks them all again.
      if (!store.freshHeartbeat(HEARTBEAT_WINDOW_MS, cfg.hosts)) {
        throw new Refusal("enforcement_unhealthy", `No enforcement host has sent a heartbeat in ${HEARTBEAT_WINDOW_MS / 60_000} minutes.`);
      }
      store.sweepExpired(cfg.graceMs);
      const held = store.liveOn(context, namespace);
      if (held !== undefined) throw new Refusal("namespace_leased", `${namespace} on ${cluster} already has lease ${held.id} (${held.state}).`);
      const limit = cfg.limits[gpuType] ?? 0;
      if (store.used(gpuType) + gpus > limit) {
        throw new Refusal("over_limit", `${gpus} ${gpuType} GPUs would pass the limit of ${limit} (${store.used(gpuType)} held).`);
      }
      if ((await threadFate(thread)) !== "live") throw new Refusal("thread_not_live", `bb does not report ${thread} as a live thread.`);
      // Confirm what the guard read, on a host, with the bot.
      let seen;
      try {
        seen = await hostCall("inspect", { context, namespace, uid, id: "" });
      } catch (error) {
        throw new Refusal("enforcement_unhealthy", message(error));
      }
      const { result } = seen;
      if (!result.ok) {
        throw result.code === "not_found"
          ? new Refusal("namespace_not_found", `${namespace} does not exist on ${cluster}.`)
          : new Refusal("inspect_failed", `Could not read ${namespace} on ${cluster} (${result.code}): ${result.error}`);
      }
      const ns = result.value;
      if (ns.uid !== uid) throw new Refusal("uid_mismatch", `${namespace} has UID ${ns.uid}, not ${uid}.`);
      if (ns.thread !== thread) throw new Refusal("not_your_namespace", `${namespace} is labelled for ${ns.thread ?? "no thread"}, not ${thread}.`);
      const allocation = Math.max(ns.dgd_gpus, ns.pod_gpus);
      if (allocation > gpus) throw new Refusal("namespace_over_lease", `${namespace} already holds ${allocation} GPUs, more than ${gpus}.`);
      if (allocation > 0 && ns.gpu_type !== gpuType) {
        throw new Refusal("gpu_type_mismatch", `${namespace} holds ${allocation} GPUs of type ${ns.gpu_type ?? "unknown"}, not ${gpuType}.`);
      }
      // Settings or profiles can change while the host calls run: check again
      // with what holds now, with no await between this and the transaction.
      const fresh = await config();
      const recheck = checkAsk({ thread, cluster, namespace, gpuType, gpus, hours }, fresh, currentProfiles());
      if (recheck.context !== context) throw new Refusal("cluster_changed", `${cluster}'s kube context changed during acquire; try again.`);
      const row = store.acquire(
        { id: newLeaseId(), thread, cluster, context, namespace, uid, gpuType, gpus, hours, approvals: recheck.approvals },
        fresh,
        HEARTBEAT_WINDOW_MS,
      );
      publish();
      return { lease_id: row.id, expires_at: iso(row.expires_at) };
    }

    const leaseArg = [{ name: "lease_id", description: "The lease, lse_...", required: true }] as const;
    const jsonFlag = { json: { type: "boolean", description: "Print JSON (lease commands always do)." } } as const;

    bb.cli.register(
      defineCli({
        name: "k8s",
        summary: "GPU leases on our k8s clusters: acquire, fence writes, release, and list",
        description: "k8s-guard calls the lease commands; agents use `bb k8s leases` to see what runs where. Every lease command prints JSON.",
        commands: {
          "lease acquire": cliCommand({
            summary: "Take a lease on one namespace for the calling thread",
            options: {
              cluster: { type: "string", required: true, description: "Kube context of an allowed cluster" },
              namespace: { type: "string", required: true, description: "The namespace k8s-guard created" },
              uid: { type: "string", required: true, description: "The namespace's UID, as the guard read it" },
              thread: { type: "string", required: true, description: "The calling thread; must match the namespace's wcep.agent/thread label" },
              "gpu-type": { type: "string", required: true, description: "GPU type, such as gb300" },
              gpus: { type: "integer", min: 1, max: 4096, required: true, description: "GPUs to hold" },
              hours: { type: "string", required: true, description: "Hours, at most the plugin's limit (4 by default)" },
              ...jsonFlag,
            },
            run: (input, ctx) =>
              json(() =>
                acquire(
                  {
                    cluster: input.options.cluster,
                    namespace: input.options.namespace,
                    uid: input.options.uid,
                    thread: input.options.thread,
                    gpuType: input.options["gpu-type"],
                    gpus: input.options.gpus,
                    hours: input.options.hours,
                  },
                  ctx,
                ),
              ),
          }),
          "lease show": cliCommand({
            summary: "Show one lease",
            positionals: leaseArg,
            options: jsonFlag,
            run: (input) =>
              json(async () => showJson(store.get(parsed(LEASE_ID, input.positionals.lease_id, "lease_id"), await config()))),
          }),
          "lease op begin": cliCommand({
            summary: "Take the lease's one operation slot for 2 minutes",
            positionals: leaseArg,
            options: jsonFlag,
            run: (input, ctx) =>
              json(async () => {
                const id = parsed(LEASE_ID, input.positionals.lease_id, "lease_id");
                const slot = store.opBegin(id, ctx.threadId, newToken(), SLOT_MS, await config());
                return { token: slot.token, deadline: iso(slot.deadline) };
              }),
          }),
          "lease op end": cliCommand({
            summary: "Free the slot, if the token still holds it",
            positionals: [...leaseArg, { name: "token", description: "The token op begin printed", required: true }],
            options: jsonFlag,
            run: (input, ctx) =>
              json(async () => store.opEnd(parsed(LEASE_ID, input.positionals.lease_id, "lease_id"), ctx.threadId, String(input.positionals.token), await config())),
          }),
          "lease release": cliCommand({
            summary: "Return the lease; its namespace is torn down at once",
            positionals: leaseArg,
            options: jsonFlag,
            run: (input, ctx) =>
              json(async () => {
                const id = parsed(LEASE_ID, input.positionals.lease_id, "lease_id");
                const row = store.release(id, ctx.threadId, await config());
                publish();
                // A release tears down at once: one reconcile now, not at the next tick.
                if (row.state === "releasing") await enforcer.reconcile(id);
                publish();
                return { state: store.find(id)!.state };
              }),
          }),
          "lease renew": cliCommand({
            summary: "Renew once, by the lease's hours, never past the hour limit",
            positionals: leaseArg,
            options: jsonFlag,
            run: (input, ctx) =>
              json(async () => {
                const row = store.renew(parsed(LEASE_ID, input.positionals.lease_id, "lease_id"), ctx.threadId, await config());
                await enforcer.sync(row);
                publish();
                return { expires_at: iso(row.expires_at) };
              }),
          }),
          leases: cliCommand({
            summary: "List what runs where: live leases, or every lease with --all",
            options: {
              all: { type: "boolean", description: "Include released and torn-down leases (the latest 200)" },
              json: { type: "boolean", description: "Print JSON" },
            },
            run: async (input) => {
              const rows = input.options.all ? store.all() : store.live();
              if (!input.options.json) return { exitCode: 0, stdout: table(rows, now()) };
              return { exitCode: 0, stdout: `${JSON.stringify(rows.map(showJson))}\n` };
            },
          }),
          flags: cliCommand({
            summary: "Open flags for the steward's digest: over-allocations, failing teardowns, extensions, settings changes",
            options: { json: { type: "boolean", description: "Print JSON" } },
            run: async (input) => {
              const rows = store.flags().map((f) => ({ id: f.id, lease_id: f.lease_id, at: iso(f.at), kind: f.kind, detail: f.detail }));
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
              return { exitCode: 0, stdout: rows.length === 0 ? "No open flags.\n" : rows.map((f) => `#${f.id} ${f.at} ${f.kind}: ${f.detail}`).join("\n") + "\n" };
            },
          }),
          "flag clear": cliCommand({
            summary: "Clear a flag once the digest has reported it",
            positionals: [{ name: "id", description: "The flag's number", required: true }],
            run: (input) =>
              json(() => {
                const id = parsed(z.coerce.number().int().positive(), input.positionals.id, "id");
                if (!store.clearFlag(id)) throw new Refusal("flag_not_found", `No open flag #${id}.`);
                return { cleared: id };
              }),
          }),
        },
      }),
    );

    function view(row: LeaseRow): LeaseView {
      return {
        id: row.id,
        thread: row.thread_id,
        cluster: row.cluster,
        namespace: row.namespace,
        gpuType: row.gpu_type,
        gpus: row.gpus,
        multiNode: row.multi_node === 1,
        state: row.state,
        reason: row.reason,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        graceDeadline: row.grace_deadline,
        renewals: row.renewals,
        extensions: store.extensions(row.id).map((e) => ({ at: e.at, minutes: e.minutes, source: e.source })),
        lastError: row.last_error,
        extendBlocked: extendBlocked(row),
      };
    }

    function refusal(error: unknown): never {
      if (error instanceof Refusal) {
        const code = error.code === "lease_not_found" ? "not_found" : error.code === "extension_too_long" ? "invalid" : "conflict";
        throw new experimental_PluginRpcRefusal({ code, message: error.message });
      }
      throw error;
    }

    bb.rpc.register(rpcContract, {
      async snapshot(): Promise<Snapshot> {
        const cfg = await config();
        store.sweepExpired(cfg.graceMs);
        const used = store.usedAll();
        const types = [...new Set([...Object.keys(cfg.limits), ...used.keys()])].sort();
        const beats = new Map(store.heartbeats().map((row) => [row.host_id, row]));
        return {
          now: now(),
          leases: store.all().map(view),
          flags: store.flags().map((f) => ({ id: f.id, leaseId: f.lease_id, at: f.at, kind: f.kind, detail: f.detail })),
          hosts: cfg.hosts.map((hostId) => {
            const beat = beats.get(hostId);
            return { hostId, at: beat?.last_ok_at ?? null, ok: beat?.ok === 1, detail: beat?.detail ?? "no heartbeat yet" };
          }),
          capacity: types.map((gpuType) => ({ gpuType, limit: cfg.limits[gpuType] ?? 0, used: used.get(gpuType) ?? 0 })),
          maxExtendHours: cfg.maxExtendMs / 3_600_000,
        };
      },
      async extend({ leaseId, minutes }) {
        let row: LeaseRow;
        try {
          row = store.extend(leaseId, minutes, await config());
        } catch (error) {
          refusal(error);
        }
        publish();
        const synced = await enforcer.sync(row);
        publish();
        return { expiresAt: row.expires_at, synced };
      },
    });

    bb.background.schedule("reconcile", "* * * * *", tick);

    bb.events.on("thread.archived", async ({ thread }) => {
      await enforcer.threadGone(thread.id, "archived");
      publish();
    });
    bb.events.on("thread.deleted", async ({ thread }) => {
      await enforcer.threadGone(thread.id, "deleted");
      publish();
    });

    // bb cannot keep settings to Ryan alone, so every change goes to the digest.
    settings.onChange((next, prev) => {
      const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => next[key] !== prev[key]);
      if (changed.length === 0) return;
      const clip = (value: unknown) => String(value).slice(0, 300);
      store.flag(null, "settings_changed", `Settings changed: ${changed.map((key) => `${key}: ${clip(prev[key])} -> ${clip(next[key])}`).join("; ")}`);
      publish();
    });
  };
}

export default createK8sLeasesPlugin();
