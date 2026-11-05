// The Hosts view model: per host, the threads running a turn, the threads
// open but idle, the turns waiting on bb's concurrency limit, and the limit.
// `bb sgc hosts`, its digest, and the page's Hosts tab all print this one
// model, so the three never disagree. Pure: the server reads bb and hands the
// answers in. No zod here: the page imports this file.
/** The concurrency-limit configuration, as `bb concurrency-limit status --json` prints it. */
export interface LimitStatus {
  globalLimit: number | null;
  hosts: Array<{
    id: string;
    name: string;
    status: string;
    /** Null until bb has measured the host's processors. */
    availableParallelism: number | null;
    automaticLimit: number;
    effectiveLimit: number;
    /** Null when the host is on its automatic limit. */
    override: number | null;
  }>;
}

/** What the server read from bb, as bb returned it. */
export interface HostsInput {
  now: number;
  /** `bb.sdk.hosts.list`: every enrolled host. */
  hosts: ReadonlyArray<{ id: string; name: string; status: string }>;
  /** Null when the limits could not be read; `limitError` says why. */
  limits: LimitStatus | null;
  limitError: string | null;
  /** `bb.sdk.threads.listRunning`: the threads holding a slot, starting or active. */
  running: ReadonlyArray<{ id: string; hostId: string | null }>;
  /** `bb.sdk.threads.count({ status: "idle", groupBy: "host" })`: idle threads per host id. */
  idle: ReadonlyArray<{ key: string | null; count: number }>;
  /** Queued rows the concurrency limit holds, each with its thread's host, null before bb gives it one. */
  waiting: ReadonlyArray<{ threadId: string; createdAt: number; hostId: string | null }>;
}

interface Counts {
  running: number;
  idle: number;
  /** Threads with a turn the limit holds: each needs one slot. */
  waiting: number;
  /** When the oldest waiting turn was queued, epoch ms. */
  oldestWaitSince: number | null;
  oldestWaitMs: number | null;
}

export interface HostRow extends Counts {
  id: string;
  name: string;
  status: string;
  /** The effective limit; null when the limits could not be read or do not list the host. */
  limit: number | null;
  limitSource: "override" | "automatic" | null;
  automaticLimit: number | null;
  atLimit: boolean;
}

/** The one model `bb sgc hosts --json`, the digest, and the Hosts tab show. */
export interface HostsView {
  checkedAt: number;
  globalLimit: number | null;
  globalAtLimit: boolean;
  /** Every running thread, on a host or not. */
  running: number;
  limitError: string | null;
  hosts: HostRow[];
  /** Threads on no host bb lists: a new thread not yet placed, or a host since removed. */
  unplaced: Counts;
}

/** The digest's name for threads on no known host. */
export const UNPLACED_NAME = "(no host)";

/** Build the view: one row per enrolled host, by name, and the threads on no known host. */
export function hostsView(input: HostsInput): HostsView {
  const known = new Set(input.hosts.map((host) => host.id));
  const place = (hostId: string | null) => (hostId !== null && known.has(hostId) ? hostId : null);
  const counts = new Map<string | null, { running: number; idle: number; oldest: Map<string, number> }>();
  const of = (key: string | null) => {
    let entry = counts.get(key);
    if (entry === undefined) counts.set(key, (entry = { running: 0, idle: 0, oldest: new Map() }));
    return entry;
  };
  for (const thread of input.running) of(place(thread.hostId)).running += 1;
  for (const group of input.idle) of(place(group.key)).idle += group.count;
  for (const row of input.waiting) {
    const oldest = of(place(row.hostId)).oldest;
    oldest.set(row.threadId, Math.min(oldest.get(row.threadId) ?? Infinity, row.createdAt));
  }
  const tally = (key: string | null): Counts => {
    const entry = counts.get(key);
    const since = entry === undefined || entry.oldest.size === 0 ? null : Math.min(...entry.oldest.values());
    return {
      running: entry?.running ?? 0,
      idle: entry?.idle ?? 0,
      waiting: entry?.oldest.size ?? 0,
      oldestWaitSince: since,
      oldestWaitMs: since === null ? null : Math.max(0, input.now - since),
    };
  };
  const limits = new Map((input.limits?.hosts ?? []).map((host) => [host.id, host]));
  const hosts = [...input.hosts]
    .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
    .map((host): HostRow => {
      const limit = limits.get(host.id);
      const row = tally(host.id);
      return {
        id: host.id,
        name: host.name,
        status: host.status,
        ...row,
        limit: limit?.effectiveLimit ?? null,
        limitSource: limit === undefined ? null : limit.override === null ? "automatic" : "override",
        automaticLimit: limit?.automaticLimit ?? null,
        atLimit: limit !== undefined && row.running >= limit.effectiveLimit,
      };
    });
  const globalLimit = input.limits?.globalLimit ?? null;
  return {
    checkedAt: input.now,
    globalLimit,
    globalAtLimit: globalLimit !== null && input.running.length >= globalLimit,
    running: input.running.length,
    limitError: input.limitError,
    hosts,
    unplaced: tally(null),
  };
}

export interface HostsDigest {
  checkedAt: number;
  limitError: string | null;
  globalLimit: number | null;
  globalAtLimit: boolean;
  running: number;
  atLimit: Array<{ id: string; name: string; running: number; limit: number; limitSource: "override" | "automatic" }>;
  waiting: Array<{ id: string | null; name: string; waiting: number; oldestWaitSince: number; oldestWaitMs: number }>;
}

/** What the steward flags: the hosts at their limit, and the hosts with turns waiting, with the oldest wait. */
export function hostsDigest(view: HostsView): HostsDigest {
  const waiting = [...view.hosts.map((host) => ({ ...host, id: host.id as string | null })), { ...view.unplaced, id: null, name: UNPLACED_NAME }]
    .filter((row) => row.waiting > 0)
    .map((row) => ({ id: row.id, name: row.name, waiting: row.waiting, oldestWaitSince: row.oldestWaitSince!, oldestWaitMs: row.oldestWaitMs! }));
  return {
    checkedAt: view.checkedAt,
    limitError: view.limitError,
    globalLimit: view.globalLimit,
    globalAtLimit: view.globalAtLimit,
    running: view.running,
    atLimit: view.hosts.flatMap((host) =>
      host.atLimit && host.limit !== null && host.limitSource !== null ? [{ id: host.id, name: host.name, running: host.running, limit: host.limit, limitSource: host.limitSource }] : [],
    ),
    waiting,
  };
}

/** A wait for people: `-`, `40 s`, `14 min`, `2 h 15 min`. */
export function waitText(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A host's limit for people: `4 (override)`, with `, at limit` when it is reached, or `-` when unknown. */
export function limitText(host: Pick<HostRow, "limit" | "limitSource" | "atLimit">): string {
  if (host.limit === null) return "-";
  return `${host.limit} (${host.limitSource})${host.atLimit ? ", at limit" : ""}`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2))).join("").trimEnd()).join("\n");
}

/** `bb sgc hosts`: a row per host, a row for threads on no known host when there are any, then the global limit. */
export function formatHosts(view: HostsView): string {
  const rows = [["Host", "ID", "Status", "Running", "Idle", "Waiting", "Oldest wait", "Limit"]];
  for (const host of view.hosts) {
    rows.push([host.name, host.id, host.status, `${host.running}`, `${host.idle}`, `${host.waiting}`, waitText(host.oldestWaitMs), limitText(host)]);
  }
  const loose = view.unplaced;
  if (loose.running + loose.idle + loose.waiting > 0) {
    rows.push([UNPLACED_NAME, "-", "-", `${loose.running}`, `${loose.idle}`, `${loose.waiting}`, waitText(loose.oldestWaitMs), "-"]);
  }
  const global = view.globalLimit === null ? "none" : `${view.globalLimit}${view.globalAtLimit ? ", reached" : ""}`;
  const lines = [table(rows), "", `Global limit: ${global}. Running: ${view.running}.`];
  if (view.limitError !== null) lines.push(`Could not read the limits: ${view.limitError}`);
  return lines.join("\n");
}

/** `bb sgc hosts --digest`: one line per flag, or one line that says there is none. */
export function formatDigest(digest: HostsDigest): string {
  const lines: string[] = [];
  if (digest.globalAtLimit) lines.push(`The global limit of ${digest.globalLimit} is reached: ${digest.running} running.`);
  if (digest.atLimit.length > 0) {
    lines.push(`At their limit: ${digest.atLimit.map((host) => `${host.name} ${host.running}/${host.limit} (${host.limitSource})`).join(", ")}.`);
  }
  if (digest.waiting.length > 0) {
    lines.push(`Waiting on the limit: ${digest.waiting.map((row) => `${row.name} ${row.waiting}, oldest ${waitText(row.oldestWaitMs)}`).join("; ")}.`);
  }
  if (lines.length === 0) lines.push(digest.limitError === null ? "No host is at its limit, and no turn waits on one." : "No turn waits on a limit.");
  if (digest.limitError !== null) lines.push(`Could not read the limits: ${digest.limitError}`);
  return lines.join("\n");
}
