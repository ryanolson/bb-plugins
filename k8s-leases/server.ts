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
  type GuardFailure,
  type Inspect,
  type LeaseView,
  type Profiles,
  type Snapshot,
} from "./lib/contract.ts";
import { createEnforcer, within, type GuardMethod, type ThreadFate } from "./lib/enforcer.ts";
import { createHosts } from "./lib/hosts.ts";
import { own } from "./lib/own.ts";
import { checkAsk } from "./lib/policy.ts";
import { Refusal } from "./lib/refusal.ts";
import { SETTINGS, parseConfig, type Config } from "./lib/settings.ts";
import { MIGRATIONS, createStore, type LeaseRow } from "./lib/store.ts";

/** `acquire` refuses unless some host sent a heartbeat this recently. */
export const HEARTBEAT_WINDOW_MS = 10 * 60_000;
/** The op slot's deadline. */
export const SLOT_MS = 2 * 60_000;
/**
 * How long the schedule handler waits for the work a tick started. None: the
 * handler starts the work and returns, whatever bb does with overlapping runs.
 * Tests set a wait so a tick settles its work.
 */
const TICK_WAIT_MS = 0;
/** A host whose guard call failed is tried last by single-host calls for this long, unless it succeeds again. */
const HOST_COOLDOWN_MS = 5 * 60_000;
/** A release waits this long for its first teardown step; the teardown goes on after that. */
const RELEASE_WAIT_MS = 20_000;
/** A thread lookup may take this long; past it the thread counts as unknown, and nothing is revoked. */
const THREAD_CHECK_MS = 20_000;
/** A namespace still there this long after its first `down` raises a teardown flag. */
const STUCK_MS = 15 * 60_000;

export interface K8sLeasesOptions {
  now?: () => number;
  newLeaseId?: () => string;
  newToken?: () => string;
  tickWaitMs?: number;
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

  return async function k8sLeases(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(SETTINGS);
    const config = async (): Promise<Config> => parseConfig(await settings.get());

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = createStore(db, now);
    const host = bb.hosts.experimental_client({ contract: hostContract });

    // One abort signal for every host call of this plugin load; it fires on unload.
    const life = new AbortController();
    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
      life.abort();
    });

    const publish = () => {
      if (!disposed) bb.realtime.publish(CHANNEL, { at: now() });
    };

    /** The settings as last read, for the sync host-order helpers. */
    let latest: Config | null = null;
    /** Bumped by every settings change, so a read that started before one can never replace it. */
    let settingsVersion = 0;
    const current = async (): Promise<Config> => {
      const version = settingsVersion;
      const read = await config();
      if (version === settingsVersion) latest = read;
      return latest ?? read;
    };

    /**
     * Run a check-and-commit with the newest settings: read them, keep the
     * newer of that read and the onChange snapshot, then run `fn` at once.
     * `fn` is synchronous, so nothing can change the settings between its
     * check and its commit. Every handler that checks a limit or a maximum
     * goes through here.
     */
    async function withSettings<T>(fn: (cfg: Config) => T): Promise<T> {
      await current();
      return fn(latest!);
    }

    /** Hosts with a good probe inside the heartbeat window, freshest first. */
    function healthy(): string[] {
      const hosts = latest?.hosts ?? [];
      const since = now() - HEARTBEAT_WINDOW_MS;
      return store
        .heartbeats()
        .filter((row) => hosts.includes(row.host_id) && row.last_ok_at !== null && row.last_ok_at > since)
        .sort((a, b) => (b.last_ok_at ?? 0) - (a.last_ok_at ?? 0))
        .map((row) => row.host_id);
    }

    const hosts = createHosts<GuardMethod>({
      call: (hostId, method, input) =>
        host.call(method, input as never, { hostId, timeoutMs: HOST_TIMEOUTS[method] + HOST_CALL_MARGIN_MS, signal: life.signal }) as Promise<{
          ok: boolean;
          code?: string;
          error?: string;
        }>,
      now,
      healthy,
      configured: () => latest?.hosts ?? [],
      cooldownMs: HOST_COOLDOWN_MS,
    });

    /** The host entry's input for a guard call: always the kube context, never the profile name. */
    function target(lease: Pick<LeaseRow, "context" | "namespace" | "uid" | "id">, cfg: Config, method: GuardMethod) {
      const base = { run: cfg.run, context: lease.context, namespace: lease.namespace };
      return method === "inspect" ? base : { ...base, uid: lease.uid, leaseId: lease.id };
    }

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

    /** Profiles read within the heartbeat window, or null: then the fallback clusters setting applies. */
    function currentProfiles(): Profiles | null {
      const saved = store.profiles();
      if (saved === undefined || saved.at <= now() - HEARTBEAT_WINDOW_MS) return null;
      const parsed = PROFILES.safeParse(JSON.parse(saved.json));
      return parsed.success ? parsed.data : null;
    }

    /**
     * Read the cluster profiles from the first host that can. A read replaces
     * the kept copy only if it started after the read that wrote it, so a slow
     * reply can never bring back a profile a newer read changed.
     */
    let profileReads = 0;
    let profileKept = 0;
    async function refreshProfiles(cfg: Config): Promise<Profiles | null> {
      const started = now();
      // Ordered by a counter, not the clock: two reads can start in the same millisecond.
      profileReads += 1;
      const mine = profileReads;
      for (const hostId of hosts.order()) {
        try {
          const read = await host.call("profiles", { command: cfg.profilesCommand }, { hostId, timeoutMs: HOST_TIMEOUTS.profiles + HOST_CALL_MARGIN_MS, signal: life.signal });
          if (disposed) return null;
          if (read.ok) {
            if (mine > profileKept) {
              profileKept = mine;
              store.saveProfiles(hostId, JSON.stringify(read.value), started);
            }
            return currentProfiles();
          }
          bb.log.warn(`profiles on ${hostId}: ${read.code}: ${read.error}`);
        } catch (error) {
          if (disposed) return null;
          bb.log.warn(`profiles on ${hostId}: ${message(error)}`);
        }
      }
      return null;
    }

    const enforcer = createEnforcer({
      store,
      now,
      hosts,
      target,
      threadFate,
      log: (text) => {
        if (!disposed) bb.log.warn(text);
      },
      changed: publish,
      disposed: () => disposed,
      threadCheckMs: THREAD_CHECK_MS,
      stuckMs: STUCK_MS,
    });

    /** Probes in flight, by host, so a hung host is not probed twice at once. */
    const probing = new Set<string>();

    async function probe(hostId: string, cfg: Config): Promise<void> {
      probing.add(hostId);
      try {
        const result = await host.call("probe", { run: cfg.run }, { hostId, timeoutMs: HOST_TIMEOUTS.probe + HOST_CALL_MARGIN_MS, signal: life.signal });
        if (!disposed) store.heartbeat(hostId, result.ok, result.detail);
      } catch (error) {
        if (!disposed) store.heartbeat(hostId, false, message(error));
      } finally {
        probing.delete(hostId);
      }
    }

    /**
     * One tick: read the lease table and start the work; nothing in it waits
     * for anything else. Every lease's step, every probe and the profile read
     * start at once, and each guard call has its own timeout. The tick waits
     * for that work at most `tickWaitMs`.
     */
    async function tick(): Promise<void> {
      if (disposed) return;
      // The settings as last read: reading them again must not stand before the dispatch.
      const cfg = latest ?? (await current());
      store.sweepExpired(cfg.graceMs);
      const work = [
        ...store.live().map((row) => enforcer.dispatch(row.id, cfg)),
        ...cfg.hosts.filter((hostId) => !probing.has(hostId)).map((hostId) => probe(hostId, cfg)),
        refreshProfiles(cfg),
        current(),
      ];
      await within(Promise.allSettled(work), tickWaitMs);
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
      const cfg = await current();
      const { context, approvals } = checkAsk({ thread, cluster, namespace, gpuType, gpus, hours }, cfg, currentProfiles() ?? (await refreshProfiles(cfg)));
      // Cheap checks first; the transaction checks them all again.
      if (!store.freshHeartbeat(HEARTBEAT_WINDOW_MS, cfg.hosts)) {
        throw new Refusal("enforcement_unhealthy", `No enforcement host has sent a heartbeat in ${HEARTBEAT_WINDOW_MS / 60_000} minutes.`);
      }
      store.sweepExpired(cfg.graceMs);
      const held = store.liveOn(context, namespace);
      if (held !== undefined) throw new Refusal("namespace_leased", `${namespace} on ${cluster} already has lease ${held.id} (${held.state}).`);
      const limit = own(cfg.limits, gpuType) ?? 0;
      if (store.used(gpuType) + gpus > limit) {
        throw new Refusal("over_limit", `${gpus} ${gpuType} GPUs would pass the limit of ${limit} (${store.used(gpuType)} held).`);
      }
      if ((await threadFate(thread)) !== "live") throw new Refusal("thread_not_live", `bb does not report ${thread} as a live thread.`);
      // Confirm what the guard read, on a host, with the bot.
      let seen;
      try {
        seen = await hosts.one<{ ok: true; value: Inspect } | GuardFailure>("inspect", target({ context, namespace, uid, id: "" }, cfg, "inspect"));
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
      const row = await withSettings((fresh) => {
        const recheck = checkAsk({ thread, cluster, namespace, gpuType, gpus, hours }, fresh, currentProfiles());
        if (recheck.context !== context) throw new Refusal("cluster_changed", `${cluster}'s kube context changed during acquire; try again.`);
        return store.acquire(
          { id: newLeaseId(), thread, cluster, context, namespace, uid, gpuType, gpus, hours, approvals: recheck.approvals },
          fresh,
          HEARTBEAT_WINDOW_MS,
        );
      });
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
                // A direct read: release checks no limit, and must not wait behind the settings cache.
                const cfg = await config();
                const row = store.release(id, ctx.threadId, cfg);
                publish();
                // A release tears down at once, not at the next tick.
                if (row.state === "releasing") await within(enforcer.dispatch(id, cfg), RELEASE_WAIT_MS);
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
                const id = parsed(LEASE_ID, input.positionals.lease_id, "lease_id");
                const { row, cfg } = await withSettings((cfg) => ({ row: store.renew(id, ctx.threadId, cfg), cfg }));
                await enforcer.sync(row, cfg);
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
          capacity: types.map((gpuType) => ({ gpuType, limit: own(cfg.limits, gpuType) ?? 0, used: used.get(gpuType) ?? 0 })),
          maxExtendHours: cfg.maxExtendMs / 3_600_000,
        };
      },
      async extend({ leaseId, minutes }) {
        let row: LeaseRow;
        let cfg: Config;
        try {
          ({ row, cfg } = await withSettings((fresh) => ({ row: store.extend(leaseId, minutes, fresh), cfg: fresh })));
        } catch (error) {
          refusal(error);
        }
        publish();
        const synced = await enforcer.sync(row, cfg);
        publish();
        return { expiresAt: row.expires_at, synced };
      },
    });

    bb.background.schedule("reconcile", "* * * * *", tick);

    bb.events.on("thread.archived", async ({ thread }) => {
      await enforcer.threadGone(thread.id, "archived", await current());
      publish();
    });
    bb.events.on("thread.deleted", async ({ thread }) => {
      await enforcer.threadGone(thread.id, "deleted", await current());
      publish();
    });

    // bb cannot keep settings to Ryan alone, so every change goes to the digest.
    settings.onChange((next, prev) => {
      const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => next[key] !== prev[key]);
      if (changed.length === 0) return;
      settingsVersion += 1;
      latest = parseConfig(next);
      const clip = (value: unknown) => String(value).slice(0, 300);
      store.flag(null, "settings_changed", `Settings changed: ${changed.map((key) => `${key}: ${clip(prev[key])} -> ${clip(next[key])}`).join("; ")}`);
      publish();
    });
  };
}

export default createK8sLeasesPlugin();
