// How the host entry speaks to `k8s-guard`: the argv of each command, as
// fixed by the guard contract, and how its output is read. Pure, so
// the exact argv is testable without a process.
import { FENCE_PROBE, INSPECT, type FenceProbe, type GuardFailure, type GuardRun, type Inspect } from "./contract.ts";

export type GuardMethod = "inspect" | "expire" | "down" | "extend" | "probe-fence";

export interface GuardTarget {
  /** The kube context, from the cluster's profile. */
  context: string;
  namespace: string;
  uid?: string;
  leaseId?: string;
  /** For `down`: the proof URL of a retired fence. */
  fenceRetired?: string;
}

/** The guard's argv. Every name was checked against its schema, so none can read as a flag. */
export function guardArgv(method: GuardMethod, target: GuardTarget): string[] {
  if (method === "probe-fence") return ["fence", "probe", "--context", target.context, target.namespace];
  const argv = [method, "--context", target.context, target.namespace];
  if (method === "inspect") return argv;
  if (target.uid === undefined || target.leaseId === undefined) throw new Error(`${method} needs a UID and a lease`);
  const leased = [...argv, "--uid", target.uid, "--lease", target.leaseId];
  // A URL has a scheme, so it never reads as a flag.
  return method === "down" && target.fenceRetired !== undefined ? [...leased, "--fence-retired", target.fenceRetired] : leased;
}

/** The guard's environment: the daemon's own, plus what the bb CLI and the bot need. */
export function guardEnv(run: GuardRun, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, BB_SERVER_URL: run.serverUrl };
  if (run.kubeconfig !== null) env.KUBECONFIG = run.kubeconfig;
  return env;
}

const MAX_ERROR = 500;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR ? `${flat.slice(0, MAX_ERROR)}...` : flat;
}

export type GuardOutcome = { ok: true; value: unknown } | GuardFailure;

/**
 * Read one guard run. Exit 0 with JSON is success. A non-zero exit carries
 * `{"error", "code"?}`; its code is kept, so `not_found` stays distinct
 * from a failure that says nothing about the namespace.
 */
export function readGuardOutput(exitCode: number, stdout: string, stderr: string): GuardOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, code: "guard_output", error: clip(`k8s-guard printed no JSON (exit ${exitCode}): ${stdout || stderr}`) };
  }
  if (exitCode === 0) return { ok: true, value: parsed };
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { error?: unknown; code?: unknown };
  const code = typeof body.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.code) ? body.code : "guard_error";
  const error = typeof body.error === "string" ? body.error : `k8s-guard exited ${exitCode}`;
  return { ok: false, code, error: clip(error) };
}

export function readInspect(outcome: GuardOutcome): { ok: true; value: Inspect } | GuardFailure {
  if (!outcome.ok) return outcome;
  const parsed = INSPECT.safeParse(outcome.value);
  if (!parsed.success) return { ok: false, code: "guard_output", error: clip(`k8s-guard inspect gave an unexpected shape: ${parsed.error.message}`) };
  return { ok: true, value: parsed.data };
}

export function readFenceProbe(outcome: GuardOutcome): { ok: true; value: FenceProbe } | GuardFailure {
  if (!outcome.ok) return outcome;
  const parsed = FENCE_PROBE.safeParse(outcome.value);
  if (!parsed.success) return { ok: false, code: "guard_output", error: clip(`k8s-guard fence probe gave an unexpected shape: ${parsed.error.message}`) };
  return { ok: true, value: parsed.data };
}
