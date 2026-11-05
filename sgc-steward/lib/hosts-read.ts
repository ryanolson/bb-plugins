// Read what the Hosts view shows from bb, and nothing else. Read only: the
// plugin never changes a limit. Only the owner, or the steward on the owner's
// word, sets limits with `bb concurrency-limit host`.
//
// The limits come from the concurrency-limit plugin's `getConfiguration` RPC,
// the read behind `bb concurrency-limit status --json`. bb does not advertise
// it, and has no SDK area for limits.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostsView, type HostsInput, type HostsView, type LimitStatus } from "./hosts.ts";

/** The plugin that holds turns past a limit, and the one read of it this view makes. */
export const LIMIT_READ = { pluginId: "concurrency-limit", method: "getConfiguration" } as const;
/** bb holds a turn past the limit as a queued row whose wait the concurrency-limit plugin owns. */
export const LIMIT_WAIT_HOLDER = `plugin:${LIMIT_READ.pluginId}` as const;
/** `threads.list` takes at most this many ids per call. */
const THREAD_IDS_PER_CALL = 200;

const limitSchema = z.number().int().min(0);
const limitStatusSchema = z.object({
  globalLimit: limitSchema.nullable(),
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      // Null until bb has measured the host's processors.
      availableParallelism: z.number().int().positive().nullable(),
      automaticLimit: limitSchema,
      effectiveLimit: limitSchema,
      override: limitSchema.nullable(),
    }),
  ),
});

/** Check the concurrency-limit configuration; throws with what was wrong. */
export function parseLimitStatus(raw: unknown): LimitStatus {
  const parsed = limitStatusSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The concurrency-limit configuration has an unexpected shape: ${issue === undefined ? "unknown" : `${issue.path.join(".")}: ${issue.message}`}`);
  }
  return parsed.data;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readLimits(sdk: PluginBbSdk): Promise<{ limits: LimitStatus | null; limitError: string | null }> {
  try {
    const raw = await sdk.plugins.callRpc({ ...LIMIT_READ, input: null, outputSchema: z.unknown() });
    return { limits: parseLimitStatus(raw), limitError: null };
  } catch (error) {
    return { limits: null, limitError: message(error) };
  }
}

/** The rows the limit holds, each with its thread's host. */
async function readWaiting(sdk: PluginBbSdk): Promise<HostsInput["waiting"]> {
  const rows = (await sdk.threads.queue.list({ waitHolder: LIMIT_WAIT_HOLDER })).filter(
    (row) => row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === LIMIT_READ.pluginId,
  );
  const ids = [...new Set(rows.map((row) => row.threadId))];
  const hostOf = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += THREAD_IDS_PER_CALL) {
    const threads = await sdk.threads.list({ threadIds: ids.slice(start, start + THREAD_IDS_PER_CALL), includeHidden: true });
    for (const thread of threads) hostOf.set(thread.id, thread.environmentHostId);
  }
  return rows.map((row) => ({ threadId: row.threadId, createdAt: row.createdAt, hostId: hostOf.get(row.threadId) ?? null }));
}

/** Read bb and build the Hosts view. A failed limits read is reported in the view; a failed thread read throws. */
export async function readHosts(sdk: PluginBbSdk, now: () => number): Promise<HostsView> {
  const [hosts, running, idle, waiting, limits] = await Promise.all([
    sdk.hosts.list(),
    sdk.threads.listRunning(),
    sdk.threads.count({ status: "idle", groupBy: "host" }),
    readWaiting(sdk),
    readLimits(sdk),
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
