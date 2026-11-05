// The two contracts of this plugin: the server's calls to its host entry,
// and the panel's calls to the server. Both are validated at the boundary,
// so a malformed value from either side is refused, never acted on.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A cluster's profile name, or a kube context. A leading `-` is refused so it can never read as a flag. */
export const CLUSTER = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,252}$/, "not a cluster or kube context name");
/** A Kubernetes namespace name (RFC 1123 label). */
export const NAMESPACE = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "not a namespace name");
/** A Kubernetes object UID. */
export const UID = z.string().regex(/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/, "not a namespace UID");
export const LEASE_ID = z.string().regex(/^lse_[a-z0-9]{8,32}$/, "not a lease id");
export const THREAD_ID = z.string().regex(/^thr_[a-z0-9]{4,64}$/, "not a bb thread id");
export const GPU_TYPE = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "not a GPU type");

/** How the host entry runs `k8s-guard`, from the plugin's settings. */
export const GUARD_RUN = z
  .object({
    /** The guard executable: a bare name looked up on PATH, an absolute path, or `~/...` on the host. */
    command: z.string().regex(/^(~\/[^\0]*|\/[^\0]*|[A-Za-z0-9._-]+)$/),
    /** `BB_SERVER_URL` for the bb CLI the guard runs; host entries get no `BB_*` variables. */
    serverUrl: z.string().url(),
    /** `KUBECONFIG` for the guard, or null to inherit. */
    kubeconfig: z.string().startsWith("/").nullable(),
  })
  .strict();
export type GuardRun = z.infer<typeof GUARD_RUN>;

/** Every guard call names the kube context (`--context`), never the profile name. */
const TARGET = { run: GUARD_RUN, context: CLUSTER, namespace: NAMESPACE };
const LEASE_TARGET = { ...TARGET, uid: UID, leaseId: LEASE_ID };

/** What `k8s-guard inspect` reports, per the guard contract. Extra fields are ignored. */
export const INSPECT = z.object({
  /** Checked as a UID: a malformed one must read as a failed lookup, never as a re-created namespace. */
  uid: UID,
  thread: z.string().nullable(),
  expires_at: z.string().nullable(),
  dgd_gpus: z.number().int().min(0),
  pod_gpus: z.number().int().min(0),
  gpu_type: z.string().nullable(),
  gpu_pods_left: z.number().int().min(0),
});
export type Inspect = z.infer<typeof INSPECT>;

/**
 * The cluster profiles (schema 1), as `k8s-check --list` prints them. Only
 * the keys the plugin reads are checked; the reader owns the rest.
 */
export const PROFILES = z.object({
  schema_version: z.literal(1),
  clusters: z.record(
    CLUSTER,
    z.object({
      context: CLUSTER,
      allowed: z.enum(["first-choice", "qa-idle", "never"]),
      bot_can_write: z.boolean().optional(),
      gpu_type: z.string().optional(),
      gpus_per_node: z.number().int().positive().optional(),
    }),
  ),
});
export type Profiles = z.infer<typeof PROFILES>;

/** A guard failure keeps its code, so `not_found` is never mistaken for a lookup that failed. */
const FAILURE = z.object({ ok: z.literal(false), code: z.string(), error: z.string() }).strict();
export type GuardFailure = z.infer<typeof FAILURE>;

export const hostContract = defineRpcContract({
  /** Heartbeat: the guard is on PATH and the bb CLI reaches this plugin. */
  probe: {
    input: z.object({ run: GUARD_RUN }).strict(),
    output: z.object({ ok: z.boolean(), detail: z.string() }).strict(),
    experimental_retryable: true,
  },
  /** The host's cluster profiles, read with `k8s-check --list`. */
  profiles: {
    input: z.object({ command: z.string().regex(/^(~\/|\/)[^\0]*$|^[A-Za-z0-9._-]+$/) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), value: PROFILES }).strict(), FAILURE]),
    experimental_retryable: true,
  },
  inspect: {
    input: z.object(TARGET).strict(),
    output: z.union([z.object({ ok: z.literal(true), value: INSPECT }).strict(), FAILURE]),
    experimental_retryable: true,
  },
  expire: {
    input: z.object(LEASE_TARGET).strict(),
    output: z.union([z.object({ ok: z.literal(true) }).strict(), FAILURE]),
  },
  /** A down that works has started the deletion; GPU pods may still be terminating. */
  down: {
    input: z.object(LEASE_TARGET).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), terminating: z.boolean().optional(), gpu_pods_left: z.number().int().min(0).optional() }).strict(),
      FAILURE,
    ]),
  },
  extend: {
    input: z.object(LEASE_TARGET).strict(),
    output: z.union([z.object({ ok: z.literal(true) }).strict(), FAILURE]),
  },
});
export type HostMethod = keyof typeof hostContract;

export type HostTimeouts = Record<HostMethod, number>;
/** How long each guard run may take on the host. `down` runs the runbook's teardown section, then deletes. */
export const HOST_TIMEOUTS: HostTimeouts = { profiles: 20_000, probe: 20_000, inspect: 60_000, expire: 120_000, extend: 60_000, down: 600_000 };
/** The server waits this much longer than the host, so the host's own timeout reports first. */
export const HOST_CALL_MARGIN_MS = 15_000;
export type WriteMethod = "expire" | "down" | "extend";

export const STATES = ["active", "revoking", "releasing", "released", "torn-down"] as const;
export type LeaseState = (typeof STATES)[number];
/** States that still hold GPUs against the limit. */
export const CHARGED: readonly LeaseState[] = ["active", "revoking", "releasing"];

const LEASE_VIEW = z.object({
  id: z.string(),
  thread: z.string(),
  cluster: z.string(),
  namespace: z.string(),
  gpuType: z.string(),
  gpus: z.number(),
  multiNode: z.boolean(),
  state: z.enum(STATES),
  reason: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  graceDeadline: z.number().nullable(),
  renewals: z.number(),
  extensions: z.array(z.object({ at: z.number(), minutes: z.number(), source: z.string() })),
  lastError: z.string().nullable(),
  /** Why Extend is not offered, or null when it is. */
  extendBlocked: z.string().nullable(),
});
export type LeaseView = z.infer<typeof LEASE_VIEW>;

const FLAG_VIEW = z.object({ id: z.number(), leaseId: z.string().nullable(), at: z.number(), kind: z.string(), detail: z.string() });
export type FlagView = z.infer<typeof FLAG_VIEW>;

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: z.object({
      now: z.number(),
      leases: z.array(LEASE_VIEW),
      flags: z.array(FLAG_VIEW),
      hosts: z.array(z.object({ hostId: z.string(), at: z.number().nullable(), ok: z.boolean(), detail: z.string() })),
      capacity: z.array(z.object({ gpuType: z.string(), limit: z.number(), used: z.number() })),
      maxExtendHours: z.number(),
    }),
  },
  extend: {
    input: z.object({ leaseId: LEASE_ID, minutes: z.number().positive().finite() }).strict(),
    output: z.object({ expiresAt: z.number(), synced: z.boolean() }),
  },
});
export type Snapshot = z.infer<(typeof rpcContract)["snapshot"]["output"]>;

export { CHANNEL } from "./panel.ts";
