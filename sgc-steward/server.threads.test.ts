import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadsView } from "./threads.ts";
import { HOUR, MINUTE } from "./lib/lifecycle.ts";
import type { DecisionRow } from "./lib/threads-view.ts";
import { rejection, setup, type FakeIssue } from "./test-support.ts";

const START = Date.parse("2026-11-20T12:00:00Z");

interface FakeThread {
  id: string;
  title: string;
  status?: string;
  providerId?: string;
  parentThreadId?: string | null;
  updatedAt?: number;
  pinnedAt?: number | null;
  queuedMessageCount?: number;
  environmentId?: string | null;
  environmentHostId?: string | null;
  tokens?: number;
  offerAt?: string;
  model?: string;
  queuedAt?: number;
}

const EVERY_READ = new Set(["hosts.list", "threads.list", "threads.context", "threads.defaultExecutionOptions", "threads.queuedMessages.list", "environments.status"]);
const CLEAN_ENV = { outcome: "available", workspace: { checkout: { kind: "branch", branchName: "f", headSha: "abc" }, mergeBase: { aheadCount: 0 }, workingTree: { state: "clean", hasUncommittedChanges: false } } };

/** The plugin on a fake bb with a clock the test moves, a few threads, and a Linear with issues. */
async function lifecycleSetup(threads: FakeThread[], options: { key?: string | null; settings?: Record<string, string> } = {}) {
  const clock = { now: START };
  const kit = await setup({ now: () => clock.now, ...options });
  const sdk = kit.harness.inspection.sdk;
  const state = { threads, env: new Map<string, unknown>(), listFails: false, archived: new Set<string>() };
  const row = (thread: FakeThread) => ({
    id: thread.id,
    title: thread.title,
    titleFallback: null,
    status: thread.status ?? "idle",
    providerId: thread.providerId ?? "claude-code",
    parentThreadId: thread.parentThreadId ?? null,
    updatedAt: thread.updatedAt ?? START - 50 * MINUTE,
    pinnedAt: thread.pinnedAt ?? null,
    queuedWork: thread.queuedMessageCount ? "waiting" : "none",
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentId: thread.environmentId === undefined ? `env_${thread.id}` : thread.environmentId,
    environmentHostId: thread.environmentHostId === undefined ? "host_a" : thread.environmentHostId,
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
      if (actFails.has(action)) throw new Error(`${action} boom`);
      acted.push(`${action} ${threadId}`);
      if (action === "archive") state.archived.add(threadId);
      return action === "archive" ? { archived: [threadId] } : { ok: true };
    });
  }
  const find = (args: unknown) => state.threads.find((thread) => thread.id === (args as { threadId: string }).threadId)!;
  sdk.stub("threads.context", async (args: unknown) => {
    const thread = find(args);
    return {
      usage: { estimated: false, modelContextWindow: 1_000_000, usedTokens: thread.tokens ?? 150_000, ...(thread.offerAt === undefined ? {} : { compactionOfferAt: thread.offerAt }) },
    };
  });
  sdk.stub("threads.defaultExecutionOptions", async (args: unknown) => ({ model: find(args).model ?? "opus" }));
  sdk.stub("threads.queuedMessages.list", async (args: unknown) => {
    const thread = find(args);
    return thread.queuedMessageCount ? [{ id: "q1", threadId: thread.id, createdAt: thread.queuedAt ?? clock.now, state: "queued" }] : [];
  });
  sdk.stub("environments.status", async (args: unknown) => structuredClone(state.env.get((args as { environmentId: string }).environmentId) ?? CLEAN_ENV));
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
  return { ...kit, clock, state, sdk, issue, list, log, row, acted, actFails, page, act };
}

const byId = (view: ThreadsView, id: string) => view.threads.find((thread) => thread.id === id)!;

test("bb sgc threads lists each thread with state, issue, provider, tokens, cache expiry, decision, and reason", async () => {
  const t = await lifecycleSetup([
    { id: "thr_done", title: "1: finished work", updatedAt: START - 50 * MINUTE },
    { id: "thr_big", title: "2: ongoing", tokens: 250_000, updatedAt: START - 50 * MINUTE },
    { id: "thr_small", title: "2: ongoing too", tokens: 20_000, updatedAt: START - 50 * MINUTE },
    { id: "thr_fresh", title: "2: just ran", updatedAt: START - 5 * MINUTE },
    { id: "thr_busy", title: "2: busy", status: "active" },
    { id: "thr_err", title: "2: broken", status: "error" },
    { id: "thr_pi", title: "2: local model", providerId: "pi", model: "kimi", updatedAt: START - 50 * MINUTE },
  ]);
  t.issue("TEAM-1", "state-done");
  t.issue("TEAM-2", "state-started");
  const view = await t.list();
  assert.equal(view.mode, "observe");
  assert.equal(view.checkedAt, START);
  const done = byId(view, "thr_done");
  assert.deepEqual(
    [done.state, done.issue?.identifier, done.provider, done.model, done.usedTokens, done.contextWindow, done.expiresAt, done.decision],
    ["done", "TEAM-1", "claude-code", "opus", 150_000, 1_000_000, START + 10 * MINUTE, "archive"],
  );
  assert.match(done.reason, /TEAM-1 is Done/);
  assert.equal(done.expiresIn, "10m");
  assert.deepEqual([byId(view, "thr_big").state, byId(view, "thr_big").decision], ["idle-active", "compact"]);
  assert.deepEqual([byId(view, "thr_small").state, byId(view, "thr_small").decision], ["idle-active", "let-cool"]);
  // 55 minutes of cache left: not yet in the window.
  assert.deepEqual([byId(view, "thr_fresh").decision, byId(view, "thr_fresh").expiresIn], ["none", "55m"]);
  assert.equal(byId(view, "thr_busy").state, "working");
  assert.deepEqual([byId(view, "thr_err").state, byId(view, "thr_err").decision], ["stuck", "flag"]);
  // Pi keeps its cache 6 hours: 5 h 10 m left, so no decision yet.
  assert.deepEqual([byId(view, "thr_pi").expiresIn, byId(view, "thr_pi").decision, byId(view, "thr_pi").model], ["5h 10m", "none", "kimi"]);
});

test("bb's own cache expiry wins over the provider table", async () => {
  const offer = new Date(START + 4 * MINUTE).toISOString();
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", offerAt: offer, updatedAt: START - 5 * MINUTE }]);
  t.issue("TEAM-1", "state-done");
  const thread = byId(await t.list(), "thr_a");
  assert.deepEqual([thread.expiresAt, thread.decision], [START + 4 * MINUTE, "archive"]);
});

test("a signed claim finds the issue; the title prefix is the fallback; no match is an orphan after a day", async () => {
  const t = await lifecycleSetup([
    { id: "thr_claimed", title: "no number in this title", updatedAt: START - 50 * MINUTE },
    { id: "thr_titled", title: "OTHER-9 wrongly keyed", updatedAt: START - 50 * MINUTE },
    { id: "thr_lost", title: "wandering", updatedAt: START - 30 * HOUR },
  ]);
  const claimed = t.issue("TEAM-5", "state-started");
  t.linear.post(claimed, "c1", "[agent:claude-code thr_claimed] claim: taking it");
  t.issue("TEAM-3", "state-done");
  const view = await t.list();
  assert.equal(byId(view, "thr_claimed").issue?.identifier, "TEAM-5");
  assert.equal(byId(view, "thr_lost").state, "orphan");
  assert.equal(byId(view, "thr_lost").decision, "flag");
  // OTHER is not this fake team's key, so the title names nothing here.
  assert.equal(byId(view, "thr_titled").issue, null);
});

test("each decision is logged once per cache life, with its inputs and reason; before the window nothing is logged", async () => {
  const t = await lifecycleSetup([
    { id: "thr_done", title: "1: finished", updatedAt: START - 50 * MINUTE },
    { id: "thr_fresh", title: "1: fresh", updatedAt: START - 5 * MINUTE },
  ]);
  t.issue("TEAM-1", "state-done");
  await t.list();
  t.clock.now += 2 * MINUTE;
  await t.list();
  t.clock.now += 2 * MINUTE;
  await t.list();
  const rows = await t.log();
  assert.equal(rows.length, 1, "the same decision in the same cache life is logged once");
  assert.deepEqual([rows[0]!.threadId, rows[0]!.decision, rows[0]!.state, rows[0]!.result], ["thr_done", "archive", "done", "observed"]);
  assert.match(rows[0]!.reason, /TEAM-1 is Done/);
  assert.equal(rows[0]!.inputs.issue, "TEAM-1");
  assert.equal(rows[0]!.inputs.providerId, "claude-code");
  assert.equal(rows[0]!.inputs.usedTokens, 150_000);
  assert.equal(typeof rows[0]!.inputs.expiresAt, "number");
});

test("a changed decision in the same window is logged again; --limit bounds the log, newest first", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", tokens: 250_000, updatedAt: START - 50 * MINUTE }]);
  t.issue("TEAM-1", "state-started");
  await t.list();
  t.state.threads[0]!.status = "active";
  t.clock.now += MINUTE;
  await t.list();
  t.state.threads[0]!.status = "idle";
  t.clock.now += MINUTE;
  await t.list();
  const all = await t.log();
  // compact, then none while working (not logged), then compact again.
  assert.deepEqual(all.map((entry) => entry.decision), ["compact"]);
  t.issue("TEAM-2", "state-done");
  t.state.threads[0]!.title = "2: x";
  t.clock.now += MINUTE;
  await t.list();
  const after = await t.log();
  assert.deepEqual(after.map((entry) => entry.decision), ["archive", "compact"]);
  assert.equal((await t.log("--limit", "1")).length, 1);
  assert.equal((await t.log("--limit", "1"))[0]!.decision, "archive");
});

test("observe mode takes no action: bb is only read, and no message goes out", async () => {
  const t = await lifecycleSetup([
    { id: "thr_done", title: "1: finished" },
    { id: "thr_big", title: "2: big", tokens: 300_000 },
    { id: "thr_err", title: "2: broken", status: "error" },
  ]);
  t.issue("TEAM-1", "state-done");
  t.issue("TEAM-2", "state-started");
  const from = t.sdk.calls.length;
  const view = await t.list();
  assert.deepEqual(view.threads.map((thread) => thread.decision).sort(), ["archive", "compact", "flag"]);
  const paths = t.sdk.calls.slice(from).map((call) => call.path);
  assert.deepEqual(paths.filter((path) => !EVERY_READ.has(path)), []);
  assert.deepEqual(t.sends, []);
  assert.ok(t.linear.calls.every((call) => !call.startsWith("createComment")));
});

test("every safety rule turns an archive into a flag with the reason, in the log", async () => {
  const t = await lifecycleSetup([
    { id: "thr_dirty", title: "1: a" },
    { id: "thr_ahead", title: "1: b" },
    { id: "thr_unread", title: "1: c" },
    { id: "thr_clean", title: "1: d" },
    { id: "thr_bare", title: "1: e", environmentId: null },
  ]);
  t.issue("TEAM-1", "state-done");
  const status = (workingTree: string, ahead: number) => ({ ...CLEAN_ENV, workspace: { ...CLEAN_ENV.workspace, mergeBase: { aheadCount: ahead }, workingTree: { state: workingTree, hasUncommittedChanges: workingTree !== "clean" } } });
  t.state.env.set("env_thr_dirty", status("dirty_uncommitted", 0));
  t.state.env.set("env_thr_ahead", status("clean", 3));
  t.state.env.set("env_thr_unread", { outcome: "unavailable", failure: { code: "path_not_found", message: "gone", workspacePath: "/x" } });
  const view = await t.list();
  const verdicts = Object.fromEntries(view.threads.map((thread) => [thread.id, thread.decision]));
  assert.deepEqual(verdicts, { thr_dirty: "flag", thr_ahead: "flag", thr_unread: "flag", thr_clean: "archive", thr_bare: "archive" });
  assert.match(byId(view, "thr_dirty").reason, /uncommitted/);
  assert.match(byId(view, "thr_ahead").reason, /commits not on its base/);
  assert.match(byId(view, "thr_unread").reason, /could not be read: gone/);
});

test("a child thread that is working blocks the parent, and shows the parent as waiting", async () => {
  const t = await lifecycleSetup([
    { id: "thr_parent", title: "1: parent" },
    { id: "thr_child", title: "x: child", parentThreadId: "thr_parent", status: "active" },
  ]);
  t.issue("TEAM-1", "state-done");
  const view = await t.list();
  assert.deepEqual([byId(view, "thr_parent").state, byId(view, "thr_parent").decision], ["waiting", "none"]);
});

test("Mission Control, the steward, and a pinned thread are protected and never get a decision", async () => {
  const t = await lifecycleSetup([
    { id: "thr_zrybxd2ijw", title: "Mission Control", status: "error" },
    { id: "thr_steward", title: "1: steward" },
    { id: "thr_pinned", title: "1: pinned", pinnedAt: 1 },
  ], { settings: { stewardThread: "thr_steward" } });
  t.issue("TEAM-1", "state-done");
  const view = await t.list();
  for (const id of ["thr_zrybxd2ijw", "thr_steward", "thr_pinned"]) {
    assert.deepEqual([byId(view, id).state, byId(view, id).decision], ["protected", "none"], id);
  }
  assert.deepEqual(await t.log(), []);
});

test("a queued turn older than 30 minutes is stuck", async () => {
  const t = await lifecycleSetup([{ id: "thr_q", title: "1: q", queuedMessageCount: 1, queuedAt: START - 40 * MINUTE }]);
  t.issue("TEAM-1", "state-started");
  assert.deepEqual([byId(await t.list(), "thr_q").state, byId(await t.list(), "thr_q").decision], ["stuck", "flag"]);
});

test("without a Linear key the threads still list, and none is an orphan or archived", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", updatedAt: START - 30 * HOUR }], { key: null });
  const view = await t.list();
  assert.match(view.linearError ?? "", /Linear/);
  assert.deepEqual([byId(view, "thr_a").state, byId(view, "thr_a").issue], ["idle-active", null]);
});

test("a failed read of bb is an error, and --cached shows the last good list without reading bb", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x" }]);
  t.issue("TEAM-1", "state-started");
  await t.list();
  t.state.listFails = true;
  const failed = await t.harness.behavior.runCli(["threads", "--json", "--cached"], { threadId: "thr_steward" });
  assert.equal(failed.exitCode, 0, failed.stderr);
  assert.equal((JSON.parse(failed.stdout) as ThreadsView).threads.length, 1);
  t.clock.now += 10 * MINUTE;
  const fresh = await t.harness.behavior.runCli(["threads", "--json"], { threadId: "thr_steward" });
  assert.equal(fresh.exitCode, 1);
  assert.match(fresh.stderr, /bb is down/);
});

test("the plain table names each column", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished work" }]);
  t.issue("TEAM-1", "state-done");
  const result = await t.harness.behavior.runCli(["threads"], { threadId: "thr_steward" });
  assert.equal(result.exitCode, 0, result.stderr);
  for (const text of ["THREAD", "STATE", "ISSUE", "PROVIDER/MODEL", "TOKENS", "EXPIRES", "DECISION", "thr_done", "done", "TEAM-1", "claude-code/opus", "150k", "10m", "archive"]) {
    assert.ok(result.stdout.includes(text), `${text} in:\n${result.stdout}`);
  }
});

// --- the Threads tab's RPC --------------------------------------------------

test("threads.list returns the snapshot, with host names, and the decision log", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }]);
  t.issue("TEAM-1", "state-done");
  const { view, log } = await t.page(true);
  assert.equal(view?.threads[0]?.hostName, "spark-d");
  assert.equal(view?.threads[0]?.decision, "archive");
  assert.deepEqual(log.map((entry) => [entry.threadId, entry.decision, entry.result]), [["thr_done", "archive", "observed"]]);
});

test("threads.list reads bb itself when no snapshot exists yet, and shows the stored one otherwise, without reading", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x" }]);
  t.issue("TEAM-1", "state-started");
  assert.equal((await t.page(false)).view?.threads.length, 1);
  t.state.listFails = true;
  assert.equal((await t.page(false)).view?.threads.length, 1, "the stored snapshot, bb not read");
  await assert.rejects(t.page(true), /bb is down/);
});

test("Keep protects a thread for 24 hours, and the log records it", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }]);
  t.issue("TEAM-1", "state-done");
  assert.equal(byId(await t.list(), "thr_done").decision, "archive");
  const kept = await t.act("thr_done", "keep");
  assert.match(kept.message, /protected for 24 hours/);
  const view = await t.list();
  assert.deepEqual([byId(view, "thr_done").state, byId(view, "thr_done").decision], ["protected", "none"]);
  const entry = (await t.log()).find((row) => row.decision === "keep")!;
  assert.deepEqual([entry.threadId, entry.result], ["thr_done", "done"]);
  assert.match(entry.reason, /24 hours/);
  t.clock.now += 24 * HOUR + MINUTE;
  assert.equal(byId(await t.list(), "thr_done").state, "done");
  assert.deepEqual(t.acted, []);
});

test("Compact now compacts an idle thread and logs it", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", tokens: 250_000 }]);
  t.issue("TEAM-1", "state-started");
  const done = await t.act("thr_a", "compact");
  assert.match(done.message, /Compacting thr_a/);
  assert.deepEqual(t.acted, ["compact thr_a"]);
  const entry = (await t.log())[0]!;
  assert.deepEqual([entry.threadId, entry.decision, entry.result], ["thr_a", "compact", "done"]);
  assert.match(entry.reason, /asked from the page/);
});

test("Archive now archives a safe thread and logs it", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x" }]);
  t.issue("TEAM-1", "state-started");
  const done = await t.act("thr_a", "archive");
  assert.match(done.message, /Archived thr_a/);
  assert.deepEqual(t.acted, ["archive thr_a"]);
  assert.deepEqual((await t.log()).map((entry) => [entry.decision, entry.result]), [["archive", "done"]]);
});

const REFUSALS: Array<[string, FakeThread, (t: Awaited<ReturnType<typeof lifecycleSetup>>) => void, RegExp]> = [
  ["a protected thread", { id: "thr_p", title: "p", pinnedAt: 1 }, () => {}, /protected/],
  ["a running thread", { id: "thr_p", title: "p", status: "active" }, () => {}, /turn is running/],
  ["a thread with a queued message", { id: "thr_p", title: "p", queuedMessageCount: 1 }, () => {}, /queued message/],
  ["a thread in error", { id: "thr_p", title: "p", status: "error" }, () => {}, /in error/],
];

for (const action of ["compact", "archive"] as const) {
  for (const [name, thread, prepare, pattern] of REFUSALS) {
    test(`${action} now refuses ${name}, takes no action, and says why`, async () => {
      const t = await lifecycleSetup([thread]);
      prepare(t);
      const refused = await rejection(t.act("thr_p", action));
      assert.match(refused.message, pattern);
      assert.match(refused.message, new RegExp(`Cannot ${action} thr_p`));
      assert.deepEqual(t.acted, []);
      assert.deepEqual(await t.log(), [], "a refusal is not an action, so nothing is logged");
    });
  }
}

test("compact now and archive now refuse a thread whose child is working", async () => {
  const t = await lifecycleSetup([
    { id: "thr_p", title: "p" },
    { id: "thr_c", title: "c", parentThreadId: "thr_p", status: "active" },
  ]);
  for (const action of ["compact", "archive"] as const) assert.match((await rejection(t.act("thr_p", action))).message, /child thread is working/);
  assert.deepEqual(t.acted, []);
});

test("archive now refuses a dirty checkout, a branch with commits not on its base, and a checkout it cannot read", async () => {
  const t = await lifecycleSetup([
    { id: "thr_dirty", title: "a" },
    { id: "thr_ahead", title: "b" },
    { id: "thr_unread", title: "c" },
  ]);
  const status = (tree: string, ahead: number) => ({ ...CLEAN_ENV, workspace: { ...CLEAN_ENV.workspace, mergeBase: { aheadCount: ahead }, workingTree: { state: tree, hasUncommittedChanges: tree !== "clean" } } });
  t.state.env.set("env_thr_dirty", status("dirty_uncommitted", 0));
  t.state.env.set("env_thr_ahead", status("clean", 2));
  t.state.env.set("env_thr_unread", { outcome: "unavailable", failure: { code: "path_not_found", message: "gone", workspacePath: "/x" } });
  assert.match((await rejection(t.act("thr_dirty", "archive"))).message, /uncommitted changes/);
  assert.match((await rejection(t.act("thr_ahead", "archive"))).message, /commits not on its base/);
  assert.match((await rejection(t.act("thr_unread", "archive"))).message, /could not be read: gone/);
  assert.deepEqual(t.acted, []);
  // A compact does not touch the checkout, so a dirty one does not stop it.
  await t.act("thr_dirty", "compact");
  assert.deepEqual(t.acted, ["compact thr_dirty"]);
});

test("an action that bb refuses is logged as failed, with the error", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x" }]);
  t.actFails.add("archive");
  const refused = await rejection(t.act("thr_a", "archive"));
  assert.match(refused.message, /archive boom/);
  const entry = (await t.log())[0]!;
  assert.deepEqual([entry.decision, entry.result, entry.error], ["archive", "failed", "archive boom"]);
});

test("an unknown thread is not found", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x" }]);
  const refused = await rejection(t.act("thr_nope", "keep"));
  assert.equal(refused.code, "not_found");
});

// --- act mode ---------------------------------------------------------------

const ACT = { threadLifecycleMode: "act", stewardThread: "thr_steward" };

test("act mode archives a safe done thread, after a signed comment on its issue, and logs it done", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }], { settings: ACT });
  const issue = t.issue("TEAM-1", "state-done");
  let commentsAtArchive = -1;
  t.sdk.stub("threads.archive", async (args: unknown) => {
    commentsAtArchive = issue.comments.length;
    const { threadId } = args as { threadId: string };
    t.acted.push(`archive ${threadId}`);
    t.state.archived.add(threadId);
    return { archived: [threadId] };
  });
  const view = await t.list();
  assert.equal(view.mode, "act");
  assert.deepEqual(t.acted, ["archive thr_done"]);
  assert.equal(commentsAtArchive, 1, "the comment is posted before the archive");
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.comments[0]!.body, "[agent:sgc-steward] archived thr_done: TEAM-1 is Done; branch f at abc");
  assert.deepEqual(view.threads.map((thread) => thread.id), [], "an archived thread leaves the list");
  const entry = (await t.log())[0]!;
  assert.deepEqual([entry.threadId, entry.decision, entry.result], ["thr_done", "archive", "done"]);
});

test("a thread that turned unsafe between the decision and the action is refused", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }], { settings: ACT });
  const issue = t.issue("TEAM-1", "state-done");
  let reads = 0;
  t.sdk.stub("environments.status", async () => {
    reads += 1;
    const tree = reads === 1 ? "clean" : "dirty_uncommitted";
    return { ...CLEAN_ENV, workspace: { ...CLEAN_ENV.workspace, workingTree: { state: tree, hasUncommittedChanges: tree !== "clean" } } };
  });
  await t.list();
  assert.ok(reads >= 2, "the checkout is read again before the action");
  assert.deepEqual(t.acted, []);
  assert.equal(issue.comments.length, 0, "no comment for an archive that did not happen");
  const entry = (await t.log()).find((row) => row.decision === "archive")!;
  assert.deepEqual([entry.result], ["refused"]);
  assert.match(entry.reason, /changed since the decision/);
  assert.match(entry.reason, /uncommitted/);
});

test("a thread that began a turn between the decision and the action is refused", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", tokens: 300_000 }], { settings: ACT });
  t.issue("TEAM-1", "state-started");
  let lists = 0;
  const original = t.state.threads;
  t.sdk.stub("threads.list", async () => {
    lists += 1;
    // The first list is the decision; later lists see a running turn.
    return original.map((thread) => t.row({ ...thread, status: lists === 1 ? "idle" : "active" }));
  });
  await t.list();
  assert.deepEqual(t.acted, []);
  assert.deepEqual((await t.log()).map((row) => [row.decision, row.result]), [["compact", "refused"]]);
});

test("compact runs once per cache life", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", tokens: 300_000 }], { settings: ACT });
  t.issue("TEAM-1", "state-started");
  await t.list();
  t.clock.now += 5 * MINUTE;
  await t.list();
  t.clock.now += 5 * MINUTE;
  await t.list();
  assert.deepEqual(t.acted, ["compact thr_a"]);
  assert.deepEqual((await t.log()).map((row) => [row.decision, row.result]), [["compact", "done"]]);
});

test("a failed compact is logged with its error and tried again in the next pass; a success after that ends it", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", tokens: 300_000 }], { settings: ACT });
  t.issue("TEAM-1", "state-started");
  t.actFails.add("compact");
  await t.list();
  t.actFails.delete("compact");
  t.clock.now += 5 * MINUTE;
  await t.list();
  assert.deepEqual(t.acted, ["compact thr_a"]);
  const rows = await t.log();
  assert.deepEqual(rows.map((row) => [row.result, row.error]), [["done", undefined], ["failed", "compact boom"]]);
});

test("the issue comment goes out once, even when the archive fails and is tried again", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }], { settings: ACT });
  const issue = t.issue("TEAM-1", "state-done");
  t.actFails.add("archive");
  await t.list();
  t.actFails.delete("archive");
  t.clock.now += 5 * MINUTE;
  await t.list();
  assert.deepEqual(t.acted, ["archive thr_done"]);
  assert.equal(issue.comments.length, 1);
});

test("an archive stops when the issue comment cannot be posted", async () => {
  const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }], { settings: ACT });
  t.issue("TEAM-1", "state-done");
  t.linear.createFaults.push("dropped", "dropped");
  await t.list();
  assert.deepEqual(t.acted, []);
  const entry = (await t.log())[0]!;
  assert.equal(entry.result, "failed");
  assert.match(entry.error ?? "", /comment/i);
});

test("a stuck thread is flagged to the steward once a day", async () => {
  const t = await lifecycleSetup([{ id: "thr_err", title: "2: broken", status: "error" }], { settings: ACT });
  t.issue("TEAM-2", "state-started");
  await t.list();
  t.clock.now += 5 * MINUTE;
  await t.list();
  t.clock.now += 5 * MINUTE;
  await t.list();
  const flags = t.sends.filter((send) => send.threadId === "thr_steward");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.input[0]!.text, "[sgc-steward] Thread thr_err stuck: the thread is in error");
  t.clock.now += 25 * HOUR;
  await t.list();
  assert.equal(t.sends.filter((send) => send.threadId === "thr_steward").length, 2, "a day later, it says so again");
});

test("an unsafe archive candidate is flagged to the steward with the reason", async () => {
  const t = await lifecycleSetup([{ id: "thr_dirty", title: "1: a" }], { settings: ACT });
  t.issue("TEAM-1", "state-done");
  t.state.env.set("env_thr_dirty", { ...CLEAN_ENV, workspace: { ...CLEAN_ENV.workspace, workingTree: { state: "dirty_uncommitted", hasUncommittedChanges: true } } });
  await t.list();
  assert.deepEqual(t.acted, []);
  assert.match(t.sends[0]!.input[0]!.text, /^\[sgc-steward\] Thread thr_dirty stuck: done but not safe to archive: the environment has uncommitted changes$/);
});

test("a failed steward message is tried again in the next pass, and not logged as sent", async () => {
  const t = await lifecycleSetup([{ id: "thr_err", title: "2: broken", status: "error" }], { settings: ACT });
  t.issue("TEAM-2", "state-started");
  let fail = true;
  t.sdk.stub("threads.send", async (args: unknown) => {
    if (fail) throw new Error("steward gone");
    t.sends.push(args as (typeof t.sends)[number]);
    return {};
  });
  await t.list();
  assert.deepEqual(t.sends, []);
  assert.equal((await t.log())[0]!.result, "failed");
  fail = false;
  t.clock.now += 5 * MINUTE;
  await t.list();
  assert.equal(t.sends.length, 1);
});

test("without a steward thread, a flag is logged and nothing is sent", async () => {
  const t = await lifecycleSetup([{ id: "thr_err", title: "2: broken", status: "error" }], { settings: { threadLifecycleMode: "act" } });
  t.issue("TEAM-2", "state-started");
  await t.list();
  assert.deepEqual(t.sends, []);
  assert.deepEqual((await t.log()).map((row) => [row.decision, row.result]), [["flag", "observed"]]);
});

test("observe mode never acts, flags, or comments, even with every other setting on", async () => {
  const t = await lifecycleSetup(
    [
      { id: "thr_done", title: "1: finished" },
      { id: "thr_big", title: "2: big", tokens: 300_000 },
      { id: "thr_err", title: "2: broken", status: "error" },
    ],
    { settings: { stewardThread: "thr_steward", lifecycleActions: "archive-done,archive-parked,compact" } },
  );
  t.issue("TEAM-1", "state-done");
  t.issue("TEAM-2", "state-started");
  const view = await t.list();
  assert.equal(view.mode, "observe");
  assert.deepEqual(t.acted, []);
  assert.deepEqual(t.sends, []);
  assert.deepEqual(t.linear.calls.filter((call) => call.startsWith("createComment")), []);
  assert.ok((await t.log()).every((row) => row.result === "observed"));
});

test("a thread that is protected, or whose child is working, is never acted on", async () => {
  const t = await lifecycleSetup(
    [
      { id: "thr_pinned", title: "1: a", pinnedAt: 1 },
      { id: "thr_parent", title: "1: b" },
      { id: "thr_child", title: "x", parentThreadId: "thr_parent", status: "active" },
    ],
    { settings: ACT },
  );
  t.issue("TEAM-1", "state-done");
  await t.list();
  assert.deepEqual(t.acted, []);
});

test("lifecycleActions turns each kind of action on or off", async () => {
  const t = await lifecycleSetup(
    [
      { id: "thr_done", title: "1: finished" },
      { id: "thr_big", title: "2: big", tokens: 300_000 },
    ],
    { settings: { ...ACT, lifecycleActions: "compact" } },
  );
  t.issue("TEAM-1", "state-done");
  t.issue("TEAM-2", "state-started");
  await t.list();
  assert.deepEqual(t.acted, ["compact thr_big"]);
  assert.deepEqual((await t.log()).find((row) => row.threadId === "thr_done")?.result, "observed");
});

test("cacheLifeOverrides changes a provider's cache life", async () => {
  const t = await lifecycleSetup([{ id: "thr_a", title: "1: x", updatedAt: START - 25 * MINUTE }], { settings: { cacheLifeOverrides: "claude-code=30" } });
  t.issue("TEAM-1", "state-done");
  const thread = byId(await t.list(), "thr_a");
  assert.deepEqual([thread.expiresAt, thread.expiresSource, thread.decision], [START + 5 * MINUTE, "override", "archive"]);
});
