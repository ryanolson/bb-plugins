// The host entry: runs on each enforcement host, only when the server calls
// it. It runs `k8s-guard`, never `kubectl`, with an argv array and no shell,
// and returns what the guard said. It decides nothing; the server does.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { ATTEMPT_ID, FENCE_REPORT, FENCE_VERDICT, HOST_TIMEOUTS, OUTCOME, PROFILES, hostContract, type GuardRun, type HostTimeouts } from "./lib/contract.ts";
import { guardArgv, guardEnv, readFenceProbe, readGuardOutput, readInspect, type GuardMethod, type GuardOutcome, type GuardTarget } from "./lib/guard.ts";

const MAX_OUTPUT = 1024 * 1024;

/** The attempts a claimed-namespace teardown resolved, as the guard prints them; anything malformed is dropped. */
const RESOLUTIONS = z.array(z.object({ attempt: ATTEMPT_ID, outcome: OUTCOME }).strip()).max(1000);

function resolutionsIn(stdout: string): Array<{ attempt: string; outcome: "committed" | "failed" | "superseded" }> | undefined {
  try {
    const parsed = RESOLUTIONS.safeParse((JSON.parse(stdout) as { resolutions?: unknown }).resolutions);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fence fields of a claimed teardown's output, each checked on its own. A malformed field is dropped,
 * and the plugin's completion then refuses: it needs every one of them.
 */
function fenceFieldsIn(stdout: string, complete: boolean): Record<string, unknown> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return {};
    body = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const kept: Record<string, unknown> = {};
  const keep = (key: string, schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }) => {
    if (!(key in body)) return;
    const parsed = schema.safeParse(body[key]);
    if (parsed.success) kept[key] = parsed.data;
  };
  if (complete) {
    for (const [key, schema] of Object.entries(FENCE_REPORT)) keep(key, schema);
  } else {
    if (body.fence_disarmed === true) kept.fence_disarmed = true;
    keep("probe", FENCE_VERDICT);
  }
  return kept;
}

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
}

function run(command: string, argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(command, argv, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, signal, windowsHide: true }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
      resolve({
        exitCode: failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: failure?.killed === true && failure.code !== "ABORT_ERR",
        missing: failure?.code === "ENOENT",
      });
    });
  });
}

/** `~/...` on this host, for commands the k8s-clusters skill deploys under the home directory. */
function expandHome(command: string): string {
  return command.startsWith("~/") ? join(homedir(), command.slice(2)) : command;
}

/** Whether `command` is an executable, on PATH or by absolute path. */
function findExecutable(command: string, path: string | undefined): string | null {
  const candidates = isAbsolute(command) ? [command] : (path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function createHostEntry(options: { timeoutMs?: Partial<HostTimeouts> } = {}) {
  const timeouts: HostTimeouts = { ...HOST_TIMEOUTS, ...options.timeoutMs };

  async function guardRun(method: GuardMethod, input: GuardTarget & { run: GuardRun }, signal: AbortSignal): Promise<{ outcome: GuardOutcome; stdout: string }> {
    const ran = await run(expandHome(input.run.command), guardArgv(method, input), guardEnv(input.run, process.env), timeouts[method], signal);
    if (ran.missing) return { outcome: { ok: false, code: "guard_missing", error: `${input.run.command} is not on PATH` }, stdout: "" };
    if (ran.timedOut) return { outcome: { ok: false, code: "guard_timeout", error: `k8s-guard ${method} ran past ${timeouts[method]} ms and was stopped` }, stdout: "" };
    return { outcome: readGuardOutput(ran.exitCode, ran.stdout, ran.stderr), stdout: ran.stdout };
  }

  async function guard(method: GuardMethod, input: GuardTarget & { run: GuardRun }, signal: AbortSignal): Promise<GuardOutcome> {
    return (await guardRun(method, input, signal)).outcome;
  }

  async function write(method: "expire" | "extend", input: GuardTarget & { run: GuardRun }, signal: AbortSignal) {
    const outcome = await guard(method, input, signal);
    return outcome.ok ? { ok: true as const } : outcome;
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      profiles: async ({ command }, context) => {
        const ran = await run(expandHome(command), ["--list"], process.env, timeouts.profiles, context.signal);
        if (ran.missing) return { ok: false as const, code: "profiles_reader_missing", error: `${command} is not installed` };
        if (ran.timedOut) return { ok: false as const, code: "profiles_timeout", error: `${command} --list ran past ${timeouts.profiles} ms` };
        let parsed: unknown;
        try {
          parsed = JSON.parse(ran.stdout);
        } catch {
          return { ok: false as const, code: "profiles_output", error: `${command} --list printed no JSON (exit ${ran.exitCode})` };
        }
        if (ran.exitCode !== 0) {
          const failures = (parsed as { failures?: Array<{ code?: unknown; message?: unknown }> }).failures;
          const first = Array.isArray(failures) ? failures[0] : undefined;
          const code = typeof first?.code === "string" && /^[a-z0-9_]{1,64}$/.test(first.code) ? first.code : "profiles_invalid";
          return { ok: false as const, code, error: typeof first?.message === "string" ? first.message.slice(0, 500) : `${command} --list exited ${ran.exitCode}` };
        }
        const profiles = PROFILES.safeParse(parsed);
        if (!profiles.success) return { ok: false as const, code: "profiles_invalid", error: profiles.error.message.slice(0, 500) };
        return { ok: true as const, value: profiles.data };
      },
      probe: async ({ run: settings }, context) => {
        if (findExecutable(expandHome(settings.command), process.env.PATH) === null) return { ok: false, detail: `${settings.command} is not on PATH` };
        // The same path the guard takes to check its authority.
        const ran = await run("bb", ["k8s", "leases", "--json"], guardEnv(settings, process.env), timeouts.probe, context.signal);
        if (ran.missing) return { ok: false, detail: "bb is not on PATH" };
        if (ran.exitCode !== 0 || ran.timedOut) {
          const why = (ran.stderr || ran.stdout).split("\n")[0]?.slice(0, 300) ?? "";
          return { ok: false, detail: `bb cannot reach the plugin: ${why}` };
        }
        try {
          JSON.parse(ran.stdout);
        } catch {
          return { ok: false, detail: "bb k8s leases printed no JSON" };
        }
        return { ok: true, detail: "ok" };
      },
      inspect: async (input, context) => readInspect(await guard("inspect", input, context.signal)),
      "probe-fence": async (input, context) => readFenceProbe(await guard("probe-fence", input, context.signal)),
      expire: (input, context) => write("expire", input, context.signal),
      down: async (input, context) => {
        const { outcome, stdout } = await guardRun("down", input, context.signal);
        const resolutions = resolutionsIn(stdout);
        if (!outcome.ok) return { ...outcome, ...(resolutions === undefined ? {} : { resolutions }), ...fenceFieldsIn(stdout, false) };
        // The deletion started. Pass on what the guard says is still terminating, and in a claimed
        // namespace whether nothing of the lease is left.
        const value = (typeof outcome.value === "object" && outcome.value !== null ? outcome.value : {}) as { terminating?: unknown; gpu_pods_left?: unknown; complete?: unknown };
        return {
          ok: true as const,
          ...(typeof value.terminating === "boolean" ? { terminating: value.terminating } : {}),
          ...(Number.isInteger(value.gpu_pods_left) && (value.gpu_pods_left as number) >= 0 ? { gpu_pods_left: value.gpu_pods_left as number } : {}),
          ...(value.complete === true ? { complete: true } : {}),
          ...(resolutions === undefined ? {} : { resolutions }),
          ...fenceFieldsIn(stdout, true),
        };
      },
      extend: (input, context) => write("extend", input, context.signal),
    },
  });
}

export default createHostEntry();
