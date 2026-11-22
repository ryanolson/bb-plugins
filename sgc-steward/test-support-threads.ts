// The thread lifecycle's test fixture: the plugin on a fake bb whose threads,
// checkouts and archive the test controls, with a clock the test moves.
import assert from "node:assert/strict";
import type { DecisionRow, ThreadsView } from "./lib/threads-view.ts";
import { HOUR, MINUTE } from "./lib/lifecycle.ts";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { ArchiveView } from "./lib/archive-view.ts";
import { setup, type FakeIssue } from "./test-support.ts";

type ThreadResponse = PluginThreadEventPayloads["thread.archived"]["thread"];

export const START = Date.parse("2026-11-20T12:00:00Z");

export interface FakeThread {
  id: string;
  title: string;
  titleFallback?: string | null;
  /** The thread's first user turn, as `threads.events.list` returns it. */
  brief?: string;
  sourceThreadId?: string | null;
  status?: string;
  providerId?: string;
  parentThreadId?: string | null;
  updatedAt?: number;
  pinnedAt?: number | null;
  queuedMessageCount?: number;
  environmentId?: string | null;
  environmentHostId?: string | null;
  /** Context size; null for a thread bb has no usage for. */
  tokens?: number | null;
  /** Epoch ms its first turn started, the `turn/started` event. */
  firstTurnAt?: number;
  /** Epoch ms of its first turn request, the `client/turn/requested` event that carries `brief`; START by default. */
  requestedAt?: number;
  offerAt?: string;
  model?: string;
  queuedAt?: number;
  /** Epoch ms bb created it. */
  createdAt?: number;
  lifecycleOwnerThreadId?: string | null;
}

export const EVERY_READ = new Set(["hosts.list", "threads.list", "threads.context", "threads.defaultExecutionOptions", "threads.queuedMessages.list", "environments.status", "environments.diffBranches"]);
export const CLEAN_ENV = { outcome: "available", workspace: { checkout: { kind: "branch", branchName: "f", headSha: "abc" }, mergeBase: { aheadCount: 0 }, workingTree: { state: "clean", hasUncommittedChanges: false } } };

/** The plugin on a fake bb with a clock the test moves, a few threads, and a Linear with issues. */
export async function lifecycleSetup(threads: FakeThread[], options: { key?: string | null; settings?: Record<string, string> } = {}) {
  const clock = { now: START };
  const kit = await setup({ now: () => clock.now, ...options });
  const sdk = kit.harness.inspection.sdk;
  const state = {
    threads,
    env: new Map<string, unknown>(),
    remote: new Map<string, string[]>(),
    listFails: false,
    archived: new Set<string>(),
    /**
     * Runs inside bb's archive call, after the thread is archived. By default it
     * sends bb's archive event, as bb does; a test replaces it to hold the reply
     * or to send the event later, or sets it to null to send none.
     */
    onArchive: ((threadId: string) => emitArchived(threadId, clock.now)) as ((threadId: string) => Promise<void>) | null,
    /** The ids bb's archive reply names; by default the thread archived. */
    archiveReply: null as ((threadId: string) => string[]) | null,
    /** Awaited by every context read, so a test can hold one. */
    contextGate: null as Promise<void> | null,
    /** Awaited at the start of bb's archive call, before bb archives anything, so a test can hold the request. */
    beforeArchive: null as (() => Promise<void>) | null,
  };
  const row = (thread: FakeThread) => ({
    id: thread.id,
    title: thread.title,
    titleFallback: thread.titleFallback ?? null,
    sourceThreadId: thread.sourceThreadId ?? null,
    status: thread.status ?? "idle",
    providerId: thread.providerId ?? "claude-code",
    parentThreadId: thread.parentThreadId ?? null,
    updatedAt: thread.updatedAt ?? START - 50 * MINUTE,
    pinnedAt: thread.pinnedAt ?? null,
    queuedWork: thread.queuedMessageCount ? "waiting" : "none",
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentId: thread.environmentId === undefined ? `env_${thread.id}` : thread.environmentId,
    environmentHostId: thread.environmentHostId === undefined ? "host_a" : thread.environmentHostId,
    createdAt: thread.createdAt ?? START - 2 * HOUR,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId ?? null,
    archivedAt: null,
    deletedAt: null,
  });
  sdk.stub("threads.list", async () => {
    if (state.listFails) throw new Error("bb is down");
    return state.threads.filter((thread) => !state.archived.has(thread.id)).map(row);
  });
  sdk.stub("hosts.list", async () => [{ id: "host_a", name: "spark-d", status: "connected" }]);
  const acted: string[] = [];
  const actFails = new Set<string>();
  for (const action of ["archive", "compact"]) {
    sdk.stub(`threads.${action}`, async (args: unknown) => {
      const { threadId } = args as { threadId: string };
      if (action === "archive") await state.beforeArchive?.();
      if (actFails.has(action)) throw new Error(`${action} boom`);
      acted.push(`${action} ${threadId}`);
      if (action === "archive") {
        state.archived.add(threadId);
        await state.onArchive?.(threadId);
      }
      return action === "archive" ? { archivedThreadIds: state.archiveReply?.(threadId) ?? [threadId] } : { ok: true };
    });
  }
  const find = (args: unknown) => state.threads.find((thread) => thread.id === (args as { threadId: string }).threadId)!;
  sdk.stub("threads.context", async (args: unknown) => {
    await state.contextGate;
    const thread = find(args);
    if (thread.tokens === null) return { usage: null };
    return {
      usage: { estimated: false, modelContextWindow: 1_000_000, usedTokens: thread.tokens ?? 150_000, ...(thread.offerAt === undefined ? {} : { compactionOfferAt: thread.offerAt }) },
    };
  });
  sdk.stub("threads.defaultExecutionOptions", async (args: unknown) => ({ model: find(args).model ?? "opus" }));
  sdk.stub("threads.queuedMessages.list", async (args: unknown) => {
    const thread = find(args);
    return thread.queuedMessageCount ? [{ id: "q1", threadId: thread.id, createdAt: thread.queuedAt ?? clock.now, state: "queued" }] : [];
  });
  sdk.stub("threads.events.list", async (args: unknown) => {
    const thread = find(args);
    const types = (args as { types?: readonly string[] }).types;
    const wants = (type: string) => types === undefined || types.includes(type);
    const events: unknown[] = [];
    if (thread.brief !== undefined && wants("client/turn/requested")) {
      events.push({
        id: `evt_${thread.id}`,
        scope: { kind: "thread" },
        threadId: thread.id,
        seq: 1,
        createdAt: thread.requestedAt ?? START,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId: `req_${thread.id}`,
          source: "spawn",
          initiator: "user",
          senderThreadId: null,
          systemMessageKind: "unlabeled",
          systemMessageSubject: null,
          input: [{ type: "text", text: thread.brief }],
        },
      });
    }
    if (thread.firstTurnAt !== undefined && wants("turn/started")) {
      events.push({ id: `evt_${thread.id}_turn`, scope: { kind: "thread" }, threadId: thread.id, seq: 2, createdAt: thread.firstTurnAt, type: "turn/started", data: {} });
    }
    return events;
  });
  sdk.stub("threads.childSummary", async (args: unknown) => {
    const { threadId } = args as { threadId: string };
    const live = state.threads.filter((thread) => !state.archived.has(thread.id));
    const below: string[] = [];
    const walk = (id: string): void => {
      for (const thread of live) {
        if (below.includes(thread.id)) continue;
        if (thread.parentThreadId === id || thread.sourceThreadId === id) {
          below.push(thread.id);
          walk(thread.id);
        }
      }
    };
    walk(threadId);
    const children = live.filter((thread) => thread.parentThreadId === threadId).length;
    return { nonDeletedChildCount: children, unarchivedDescendantCount: below.length };
  });
  sdk.stub("environments.status", async (args: unknown) => structuredClone(state.env.get((args as { environmentId: string }).environmentId) ?? CLEAN_ENV));
  sdk.stub("environments.diffBranches", async (args: unknown) => ({
    branches: [],
    branchesTruncated: false,
    remoteBranches: state.remote.get((args as { environmentId: string }).environmentId) ?? [],
    remoteBranchesTruncated: false,
    selectedBranch: null,
  }));
  const issue = (identifier: string, stateId: string, labels: string[] = []): FakeIssue => {
    const made = kit.linear.addIssue(identifier, labels, "TEAM");
    const found = kit.linear.states.find((candidate) => candidate.id === stateId)!;
    made.state = { id: found.id, type: found.type };
    return made;
  };
  const list = async (...args: string[]) => {
    const result = await kit.harness.behavior.runCli(["threads", "--json", ...args], { threadId: "thr_steward" });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout) as ThreadsView;
  };
  const log = async (...args: string[]) => {
    const result = await kit.harness.behavior.runCli(["threads", "log", "--json", ...args], { threadId: "thr_steward" });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout) as Array<{ threadId: string; decision: string; reason: string; state: string; inputs: Record<string, unknown>; result: string; at: number }>;
  };
  const page = async (refresh = false) =>
    (await kit.harness.behavior.callRpc("threads.list", { refresh })) as { view: ThreadsView | null; log: DecisionRow[] };
  const act = (threadId: string, action: "keep" | "compact" | "archive") => kit.harness.behavior.callRpc("threads.act", { threadId, action }) as Promise<{ message: string }>;
  /** The Archive tab, as the page reads it. */
  const archive = async () => (await kit.harness.behavior.callRpc("archive.list", null)) as ArchiveView;
  /** bb announcing an archive, as it does for any archive: the plugin's own, another thread's, or a cascade. */
  async function emitArchived(id: string, archivedAt: number, overrides: Partial<ThreadResponse> = {}): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.id === id);
    const { errors } = await kit.harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({
        id,
        title: thread?.title ?? null,
        parentThreadId: thread?.parentThreadId ?? null,
        providerId: thread?.providerId ?? "claude-code",
        createdAt: thread?.createdAt ?? START - 2 * HOUR,
        archivedAt,
        ...overrides,
      }),
    });
    assert.deepEqual(errors, []);
  }
  const emitUnarchived = async (id: string) => {
    const { errors } = await kit.harness.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id, archivedAt: null }) });
    assert.deepEqual(errors, []);
  };
  return { ...kit, clock, state, sdk, issue, list, log, row, acted, actFails, page, act, archive, emitArchived, emitUnarchived };
}

export const byId = (view: ThreadsView, id: string) => view.threads.find((thread) => thread.id === id)!;
