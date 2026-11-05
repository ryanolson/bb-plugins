// A fake bb state for the Hosts view: five hosts, one in each state the view
// must tell apart, and queued rows the view must not count.
import type { HostsInput, LimitStatus } from "./lib/hosts.ts";

export const NOW = Date.parse("2026-11-05T18:00:00Z");
export const MINUTE = 60_000;

/** As `bb.sdk.hosts.list` returns them, with only the fields the view reads. */
export const HOSTS = [
  { id: "host_under", name: "under", status: "connected" },
  { id: "host_at", name: "at", status: "connected" },
  { id: "host_wait", name: "waiting", status: "connected" },
  { id: "host_down", name: "down", status: "disconnected" },
  { id: "host_auto", name: "auto", status: "connected" },
] as const;

/** The configuration without bb's overrides list, which the view does not read. */
export const LIMITS: LimitStatus = {
  globalLimit: null,
  hosts: [
    { id: "host_under", name: "under", status: "connected", availableParallelism: 20, automaticLimit: 20, effectiveLimit: 4, override: 4 },
    { id: "host_at", name: "at", status: "connected", availableParallelism: 20, automaticLimit: 20, effectiveLimit: 4, override: 4 },
    { id: "host_wait", name: "waiting", status: "connected", availableParallelism: 72, automaticLimit: 72, effectiveLimit: 2, override: 2 },
    { id: "host_down", name: "down", status: "disconnected", availableParallelism: 12, automaticLimit: 12, effectiveLimit: 12, override: null },
    { id: "host_auto", name: "auto", status: "connected", availableParallelism: 8, automaticLimit: 8, effectiveLimit: 8, override: null },
  ],
};

/** As the concurrency-limit plugin's `getConfiguration` RPC returns it. */
export const LIMITS_RPC = {
  globalLimit: null,
  hostOverrides: LIMITS.hosts.filter((host) => host.override !== null).map((host) => ({ hostId: host.id, limit: host.override })),
  hosts: LIMITS.hosts,
};

/** As `bb.sdk.threads.listRunning` returns them: starting or active threads. */
export const RUNNING = [
  { id: "thr_u1", hostId: "host_under" },
  ...["thr_a1", "thr_a2", "thr_a3", "thr_a4"].map((id) => ({ id, hostId: "host_at" })),
  { id: "thr_w1", hostId: "host_wait" },
  { id: "thr_w2", hostId: "host_wait" },
  ...["thr_x1", "thr_x2", "thr_x3"].map((id) => ({ id, hostId: "host_auto" })),
];

/** As `bb.sdk.threads.count({ status: "idle", groupBy: "host" })` returns them. */
export const IDLE = {
  total: 9,
  groups: [
    { key: "host_under", count: 3 },
    { key: "host_at", count: 1 },
    { key: "host_wait", count: 2 },
    { key: "host_down", count: 2 },
    { key: null, count: 1 },
  ],
};

const LIMIT_WAIT = { kind: "plugin", pluginId: "concurrency-limit", reason: "The host is at its limit of 2 running threads." } as const;

/** Every queued row in the workspace, as `bb.sdk.threads.queue.list` returns them. */
export const QUEUE = [
  // Two rows of one thread: one waiting turn, as old as its oldest row.
  { id: "qmsg_1", threadId: "thr_w3", state: "waiting", waitingOn: LIMIT_WAIT, createdAt: NOW - 14 * MINUTE },
  { id: "qmsg_2", threadId: "thr_w3", state: "waiting", waitingOn: LIMIT_WAIT, createdAt: NOW - 5 * MINUTE },
  { id: "qmsg_3", threadId: "thr_w4", state: "waiting", waitingOn: LIMIT_WAIT, createdAt: NOW - 3 * MINUTE },
  // Behind its own thread's turn, not the limit.
  { id: "qmsg_4", threadId: "thr_u2", state: "waiting", waitingOn: { kind: "thread-busy" }, createdAt: NOW - 30 * MINUTE },
  // A new thread, held before bb gave it a workspace: it has no host yet.
  { id: "qmsg_5", threadId: "thr_new", state: "waiting", waitingOn: LIMIT_WAIT, createdAt: NOW - 1 * MINUTE },
  // Held by another plugin.
  { id: "qmsg_6", threadId: "thr_a5", state: "waiting", waitingOn: { kind: "plugin", pluginId: "rate-limit", reason: "Slow down." }, createdAt: NOW - 40 * MINUTE },
];

/** The threads of the queued rows, as `bb.sdk.threads.list` returns them. */
export const THREADS = [
  { id: "thr_w3", environmentHostId: "host_wait" },
  { id: "thr_w4", environmentHostId: "host_wait" },
  { id: "thr_u2", environmentHostId: "host_under" },
  { id: "thr_new", environmentHostId: null },
  { id: "thr_a5", environmentHostId: "host_at" },
];

/** The rows the limit holds, with each thread's host, as the server hands them to the view. */
export const WAITING = [
  { threadId: "thr_w3", createdAt: NOW - 14 * MINUTE, hostId: "host_wait" },
  { threadId: "thr_w3", createdAt: NOW - 5 * MINUTE, hostId: "host_wait" },
  { threadId: "thr_w4", createdAt: NOW - 3 * MINUTE, hostId: "host_wait" },
  { threadId: "thr_new", createdAt: NOW - 1 * MINUTE, hostId: null },
];

export function input(overrides: Partial<HostsInput> = {}): HostsInput {
  return {
    now: NOW,
    hosts: HOSTS.map((host) => ({ ...host })),
    limits: structuredClone(LIMITS),
    limitError: null,
    running: RUNNING.map((row) => ({ ...row })),
    idle: IDLE.groups.map((group) => ({ ...group })),
    waiting: WAITING.map((row) => ({ ...row })),
    ...overrides,
  };
}

/** What each host must show, in the view's order: by name. */
export const EXPECTED_HOSTS = [
  {
    id: "host_at",
    name: "at",
    status: "connected",
    running: 4,
    idle: 1,
    waiting: 0,
    oldestWaitSince: null,
    oldestWaitMs: null,
    limit: 4,
    limitSource: "override",
    automaticLimit: 20,
    atLimit: true,
  },
  {
    id: "host_auto",
    name: "auto",
    status: "connected",
    running: 3,
    idle: 0,
    waiting: 0,
    oldestWaitSince: null,
    oldestWaitMs: null,
    limit: 8,
    limitSource: "automatic",
    automaticLimit: 8,
    atLimit: false,
  },
  {
    id: "host_down",
    name: "down",
    status: "disconnected",
    running: 0,
    idle: 2,
    waiting: 0,
    oldestWaitSince: null,
    oldestWaitMs: null,
    limit: 12,
    limitSource: "automatic",
    automaticLimit: 12,
    atLimit: false,
  },
  {
    id: "host_under",
    name: "under",
    status: "connected",
    running: 1,
    idle: 3,
    waiting: 0,
    oldestWaitSince: null,
    oldestWaitMs: null,
    limit: 4,
    limitSource: "override",
    automaticLimit: 20,
    atLimit: false,
  },
  {
    id: "host_wait",
    name: "waiting",
    status: "connected",
    running: 2,
    idle: 2,
    waiting: 2,
    oldestWaitSince: NOW - 14 * MINUTE,
    oldestWaitMs: 14 * MINUTE,
    limit: 2,
    limitSource: "override",
    automaticLimit: 72,
    atLimit: true,
  },
];

/** Threads bb places on no known host. */
export const EXPECTED_UNPLACED = { running: 0, idle: 1, waiting: 1, oldestWaitSince: NOW - MINUTE, oldestWaitMs: MINUTE };
