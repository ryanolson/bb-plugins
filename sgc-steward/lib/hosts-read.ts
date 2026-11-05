// Read what the Hosts view shows from bb, and nothing else. Read only: the
// plugin never changes a limit. Only the owner, or the steward on the owner's
// word, sets limits with `bb concurrency-limit host`.
//
// The threads come from the SDK. The limits come from the bb CLI, because the
// concurrency-limit plugin publishes no RPC and the SDK has no limits area:
// `bb concurrency-limit status --json` is the only way bb gives them out.
import { execFile } from "node:child_process";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostsView, type HostsInput, type HostsView, type LimitStatus } from "./hosts.ts";

/** The one bb command the plugin runs. */
export const LIMIT_STATUS_ARGS = ["concurrency-limit", "status", "--json"] as const;
/** bb holds a turn past the limit as a queued row whose wait this plugin owns. */
export const LIMIT_WAIT_HOLDER = "plugin:concurrency-limit";
const LIMIT_PLUGIN = "concurrency-limit";
/** `threads.list` takes at most this many ids per call. */
const THREAD_IDS_PER_CALL = 200;
const BB_TIMEOUT_MS = 15_000;

/** Runs the bb CLI with these arguments and returns its stdout. */
export type RunBb = (args: readonly string[]) => Promise<string>;

/**
 * Wrap a bb runner so it runs `bb concurrency-limit status --json` and
 * refuses anything else before it starts, so no later edit can make this
 * view change a limit.
 */
export function readOnlyBb(run: RunBb): RunBb {
  return async (args) => {
    if (args.length !== LIMIT_STATUS_ARGS.length || args.some((arg, index) => arg !== LIMIT_STATUS_ARGS[index])) {
      throw new Error(`The Hosts view is read only; it runs only \`bb ${LIMIT_STATUS_ARGS.join(" ")}\`, not \`bb ${args.join(" ")}\`.`);
    }
    return run(args);
  };
}

/** Run the bb CLI on the bb server: `$BB_CLI` when bb set it, else `bb` on the PATH. */
export const runBbCli: RunBb = (args) =>
  new Promise((resolve, reject) => {
    const bin = process.env.BB_CLI?.trim() || "bb";
    execFile(bin, [...args], { timeout: BB_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = String(stderr).trim().split("\n")[0] ?? "";
        reject(new Error(`${bin} ${args.join(" ")} failed: ${error.message}${detail === "" ? "" : `: ${detail}`}`));
      } else resolve(String(stdout));
    });
  });

const limitStatusSchema = z.object({
  globalLimit: z.number().int().nullable(),
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      availableParallelism: z.number(),
      automaticLimit: z.number().int(),
      effectiveLimit: z.number().int(),
      override: z.number().int().nullable(),
    }),
  ),
});

/** Parse `bb concurrency-limit status --json`; throws with what was wrong. */
export function parseLimitStatus(text: string): LimitStatus {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`bb concurrency-limit status printed something that is not JSON: ${text.trim().slice(0, 200)}`);
  }
  const parsed = limitStatusSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`bb concurrency-limit status printed an unexpected shape: ${issue === undefined ? "unknown" : `${issue.path.join(".")}: ${issue.message}`}`);
  }
  return parsed.data;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readLimits(runBb: RunBb): Promise<{ limits: LimitStatus | null; limitError: string | null }> {
  try {
    return { limits: parseLimitStatus(await runBb(LIMIT_STATUS_ARGS)), limitError: null };
  } catch (error) {
    return { limits: null, limitError: message(error) };
  }
}

/** The rows the limit holds, each with its thread's host. */
async function readWaiting(sdk: PluginBbSdk): Promise<HostsInput["waiting"]> {
  const rows = (await sdk.threads.queue.list({ waitHolder: LIMIT_WAIT_HOLDER })).filter(
    (row) => row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === LIMIT_PLUGIN,
  );
  const ids = [...new Set(rows.map((row) => row.threadId))];
  const hostOf = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += THREAD_IDS_PER_CALL) {
    const threads = await sdk.threads.list({ threadIds: ids.slice(start, start + THREAD_IDS_PER_CALL), includeHidden: true });
    for (const thread of threads) hostOf.set(thread.id, thread.environmentHostId);
  }
  return rows.map((row) => ({ threadId: row.threadId, createdAt: row.createdAt, hostId: hostOf.get(row.threadId) ?? null }));
}

/** Read bb and build the Hosts view. A failed limits read is reported in the view; a failed SDK read throws. */
export async function readHosts(sdk: PluginBbSdk, runBb: RunBb, now: () => number): Promise<HostsView> {
  const [hosts, running, idle, waiting, limits] = await Promise.all([
    sdk.hosts.list(),
    sdk.threads.listRunning(),
    sdk.threads.count({ status: "idle", groupBy: "host" }),
    readWaiting(sdk),
    readLimits(runBb),
  ]);
  return hostsView({
    now: now(),
    hosts: hosts.map((host) => ({ id: host.id, name: host.name, status: host.status })),
    ...limits,
    running: running.map((thread) => ({ id: thread.id, hostId: thread.hostId })),
    idle: idle.groups ?? [],
    waiting,
  });
}
