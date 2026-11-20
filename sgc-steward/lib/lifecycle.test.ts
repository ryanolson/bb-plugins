import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_MIN_TOKENS,
  HOUR,
  MINUTE,
  MISSION_CONTROL_THREAD,
  cacheExpiry,
  claimThread,
  classify,
  decide,
  formatExpiresIn,
  issueFor,
  cacheLifeOverridesProblem,
  lifecycleActionsProblem,
  parseCacheLifeOverrides,
  parseLifecycleActions,
  safetyBlockers,
  titleIdentifier,
  type EnvFacts,
  type IssueFacts,
  type IssueWithComments,
  type LifecycleContext,
  type ThreadFacts,
} from "./lifecycle.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const CLEAN: EnvFacts = { known: true, clean: true, ahead: false, branch: "feature", head: "abc1234", detail: null };

function thread(extra: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    id: "thr_a",
    title: "1678: something",
    status: "idle",
    parentThreadId: null,
    providerId: "claude-code",
    model: "opus",
    lastActivityAt: NOW - 50 * MINUTE,
    pinned: false,
    usedTokens: 150_000,
    contextWindow: 1_000_000,
    compactionOfferAt: null,
    cost: null,
    queuedCount: 0,
    oldestQueuedAt: null,
    childWorking: false,
    environmentId: "env_a",
    hostId: "host_a",
    env: CLEAN,
    ...extra,
  };
}

function issue(stateName: string, stateType: string, extra: Partial<IssueFacts> = {}): IssueFacts {
  return { id: "uuid-1678", identifier: "TEAM-1678", url: "linear://x", title: "t", stateName, stateType, labels: [], updatedAt: NOW - HOUR, ...extra };
}

function context(extra: Partial<LifecycleContext> = {}): LifecycleContext {
  return { now: NOW, issue: issue("In Progress", "started"), stewardThread: "thr_steward", ...extra };
}

const stateOf = (facts: ThreadFacts, ctx: LifecycleContext) => classify(facts, ctx).state;

test("a thread with a running turn is working", () => {
  for (const status of ["active", "starting", "stopping", "pending"]) assert.equal(stateOf(thread({ status }), context()), "working");
});

test("an idle thread with a queued message, or with a running child, is waiting", () => {
  assert.equal(stateOf(thread({ queuedCount: 1, oldestQueuedAt: NOW - MINUTE }), context()), "waiting");
  assert.equal(stateOf(thread({ childWorking: true }), context()), "waiting");
});

test("an idle thread whose issue is In Progress or Todo is idle-active", () => {
  assert.equal(stateOf(thread(), context()), "idle-active");
  assert.equal(stateOf(thread(), context({ issue: issue("Todo", "unstarted") })), "idle-active");
});

test("parked: a paused backlog issue, a waiting label, and a review with 48 quiet hours", () => {
  assert.equal(stateOf(thread(), context({ issue: issue("Backlog", "backlog", { labels: ["paused"] }) })), "parked");
  assert.equal(stateOf(thread(), context({ issue: issue("In Progress", "started", { labels: ["waiting:ryan-action"] }) })), "parked");
  const quiet = { updatedAt: NOW - 49 * HOUR };
  assert.equal(stateOf(thread({ lastActivityAt: NOW - 49 * HOUR }), context({ issue: issue("In Review", "started", quiet) })), "parked");
  // A backlog issue without paused, and a review changed an hour ago, are not parked.
  assert.equal(stateOf(thread(), context({ issue: issue("Backlog", "backlog") })), "idle-active");
  assert.equal(stateOf(thread(), context({ issue: issue("In Review", "started") })), "idle-active");
});

test("done: the issue is Done or Canceled", () => {
  assert.equal(stateOf(thread(), context({ issue: issue("Done", "completed") })), "done");
  assert.equal(stateOf(thread(), context({ issue: issue("Canceled", "canceled") })), "done");
});

test("orphan: no issue and idle 24 hours; sooner it is idle-active; with Linear unread it is never an orphan", () => {
  assert.equal(stateOf(thread({ lastActivityAt: NOW - 25 * HOUR }), context({ issue: null })), "orphan");
  assert.equal(stateOf(thread({ lastActivityAt: NOW - 2 * HOUR }), context({ issue: null })), "idle-active");
  assert.equal(stateOf(thread({ lastActivityAt: NOW - 25 * HOUR }), context({ issue: undefined })), "idle-active");
});

test("stuck: an error status, or a queued turn older than 30 minutes", () => {
  assert.equal(stateOf(thread({ status: "error" }), context()), "stuck");
  assert.equal(stateOf(thread({ queuedCount: 1, oldestQueuedAt: NOW - 31 * MINUTE }), context()), "stuck");
  assert.equal(stateOf(thread({ queuedCount: 1, oldestQueuedAt: NOW - 29 * MINUTE }), context()), "waiting");
  // A long-running turn with an old queue is working, not stuck.
  assert.equal(stateOf(thread({ status: "active", queuedCount: 1, oldestQueuedAt: NOW - 3 * HOUR }), context()), "working");
});

test("Mission Control, the steward, and a pinned thread are protected, whatever else is true", () => {
  const sick = { status: "error", usedTokens: 900_000 } as const;
  assert.equal(stateOf(thread({ id: MISSION_CONTROL_THREAD, ...sick }), context()), "protected");
  assert.equal(stateOf(thread({ id: "thr_steward", ...sick }), context()), "protected");
  assert.equal(stateOf(thread({ pinned: true, ...sick }), context({ issue: issue("Done", "completed") })), "protected");
  assert.equal(stateOf(thread(), context({ keptUntil: NOW + HOUR })), "protected");
  assert.equal(stateOf(thread(), context({ keptUntil: NOW - HOUR })), "idle-active");
});

test("the cache expires at bb's offer time when it gives one", () => {
  const offer = NOW + 7 * MINUTE;
  assert.deepEqual(cacheExpiry(thread({ compactionOfferAt: offer, providerId: "pi" })), { at: offer, source: "offer" });
});

test("without an offer the cache expires after the provider's life", () => {
  const last = NOW - 10 * MINUTE;
  const at = (providerId: string, overrides = {}) => cacheExpiry(thread({ providerId, lastActivityAt: last }), overrides).at - last;
  assert.equal(at("claude-code"), HOUR);
  assert.equal(at("codex"), HOUR);
  assert.equal(at("pi"), 6 * HOUR);
  assert.equal(at("acp-opencode"), 6 * HOUR);
  assert.equal(at("somebody-new"), HOUR);
  assert.equal(at("pi", { pi: 2 * HOUR }), 2 * HOUR);
  assert.equal(cacheExpiry(thread({ providerId: "pi", lastActivityAt: last }), { pi: 2 * HOUR }).source, "override");
});

/** A thread whose cache (claude-code, 1 h) expires `left` ms from now. */
const expiringIn = (left: number, extra: Partial<ThreadFacts> = {}) => thread({ lastActivityAt: NOW + left - HOUR, ...extra });

test("the decision is made only in the last 15 minutes of the cache", () => {
  const done = context({ issue: issue("Done", "completed") });
  const verdict = (left: number) => {
    const facts = expiringIn(left);
    return decide(facts, classify(facts, done), done);
  };
  assert.equal(verdict(16 * MINUTE).decision, "none");
  assert.equal(verdict(16 * MINUTE).inWindow, false);
  assert.equal(verdict(15 * MINUTE).decision, "archive");
  assert.equal(verdict(1 * MINUTE).decision, "archive");
  assert.equal(verdict(-1).decision, "none");
  assert.match(verdict(-1).reason, /cold/);
});

test("a cache that lives under 15 minutes decides in its last 5 minutes", () => {
  const done = context({ issue: issue("Done", "completed") });
  const short = (left: number) => {
    const facts = thread({ providerId: "quick", lastActivityAt: NOW + left - 10 * MINUTE });
    return decide(facts, classify(facts, done), done, { quick: 10 * MINUTE }).decision;
  };
  assert.equal(short(6 * MINUTE), "none");
  assert.equal(short(5 * MINUTE), "archive");
});

test("archive: a done or parked thread that is safe", () => {
  const done = context({ issue: issue("Done", "completed") });
  const parked = context({ issue: issue("Backlog", "backlog", { labels: ["paused"] }) });
  for (const ctx of [done, parked]) {
    const facts = expiringIn(10 * MINUTE);
    assert.equal(decide(facts, classify(facts, ctx), ctx).decision, "archive");
  }
});

test("compact: idle-active, 100k tokens or more, with an open issue", () => {
  const ctx = context();
  const facts = expiringIn(10 * MINUTE, { usedTokens: COMPACT_MIN_TOKENS });
  const verdict = decide(facts, classify(facts, ctx), ctx);
  assert.equal(verdict.decision, "compact");
});

test("let-cool: idle-active under 100k tokens, or with no issue to resume", () => {
  const ctx = context();
  const small = expiringIn(10 * MINUTE, { usedTokens: COMPACT_MIN_TOKENS - 1 });
  assert.equal(decide(small, classify(small, ctx), ctx).decision, "let-cool");
  const noIssue = context({ issue: null });
  const big = expiringIn(10 * MINUTE);
  assert.equal(decide(big, classify(big, noIssue), noIssue).decision, "let-cool");
});

test("flag: a stuck or orphan thread, in or out of the window", () => {
  const ctx = context();
  const stuck = thread({ status: "error", lastActivityAt: NOW - 10 * HOUR });
  const verdict = decide(stuck, classify(stuck, ctx), ctx);
  assert.deepEqual([verdict.decision, verdict.reason], ["flag", "the thread is in error"]);
  const orphanCtx = context({ issue: null });
  const orphan = thread({ lastActivityAt: NOW - 30 * HOUR });
  assert.equal(decide(orphan, classify(orphan, orphanCtx), orphanCtx).decision, "flag");
});

test("working and waiting threads get no decision", () => {
  const ctx = context();
  for (const facts of [expiringIn(5 * MINUTE, { status: "active" }), expiringIn(5 * MINUTE, { queuedCount: 1, oldestQueuedAt: NOW })]) {
    assert.equal(decide(facts, classify(facts, ctx), ctx).decision, "none");
  }
});

// Every safety rule blocks an archive, and the candidate becomes a flag with the reason.
const UNSAFE: Array<[string, Partial<ThreadFacts>, RegExp]> = [
  ["a dirty environment", { env: { ...CLEAN, clean: false } }, /uncommitted/],
  ["a branch ahead of its base", { env: { ...CLEAN, ahead: true } }, /commits not on its base/],
  ["an environment that could not be read", { env: { ...CLEAN, known: false, detail: "gone" } }, /could not be read: gone/],
  ["an environment that was never checked", { env: undefined }, /not checked/],
  ["a child that is working", { childWorking: true }, /child thread is working/],
];

for (const [name, change, pattern] of UNSAFE) {
  test(`${name} blocks an archive`, () => {
    const ctx = context({ issue: issue("Done", "completed") });
    const facts = expiringIn(10 * MINUTE, change);
    assert.match(safetyBlockers(facts, ctx).join(";"), pattern);
    // Classified as done, as the caller would for a child that started a moment ago.
    const verdict = decide(facts, { state: "done", reason: "TEAM-1678 is Done" }, ctx);
    assert.equal(verdict.decision, "flag");
    assert.match(verdict.reason, pattern);
  });
}

test("a thread with no environment is safe to archive", () => {
  const ctx = context({ issue: issue("Done", "completed") });
  const facts = expiringIn(10 * MINUTE, { env: null, environmentId: null });
  assert.deepEqual(safetyBlockers(facts, ctx), []);
});

test("a protected thread is never acted on, even when told it is done and safe", () => {
  const ctx = context({ issue: issue("Done", "completed") });
  for (const facts of [expiringIn(5 * MINUTE, { id: MISSION_CONTROL_THREAD }), expiringIn(5 * MINUTE, { id: "thr_steward" }), expiringIn(5 * MINUTE, { pinned: true })]) {
    assert.equal(decide(facts, classify(facts, ctx), ctx).decision, "none");
    // Even if a caller forced the done state, the archive stays blocked.
    assert.notEqual(decide(facts, { state: "done", reason: "x" }, ctx).decision, "archive");
  }
});

test("the countdown reads in minutes and hours, and cold once past", () => {
  assert.equal(formatExpiresIn(0), "cold");
  assert.equal(formatExpiresIn(-5), "cold");
  assert.equal(formatExpiresIn(10 * MINUTE), "10m");
  assert.equal(formatExpiresIn(HOUR), "1h");
  assert.equal(formatExpiresIn(HOUR + 5 * MINUTE), "1h 5m");
});

test("lifecycleActions and cacheLifeOverrides settings parse, and bad values are named", () => {
  assert.deepEqual([...parseLifecycleActions("archive-done, compact")].sort(), ["archive-done", "compact"]);
  assert.deepEqual([...parseLifecycleActions(undefined)], []);
  assert.deepEqual([...parseLifecycleActions("archive-done,nope")], ["archive-done"]);
  assert.match(lifecycleActionsProblem("archive-done,nope") ?? "", /Unknown action nope/);
  assert.equal(lifecycleActionsProblem("archive-done, compact"), null);
  assert.deepEqual(parseCacheLifeOverrides("pi=360, claude-code=30"), { pi: 6 * HOUR, "claude-code": 30 * MINUTE });
  assert.deepEqual(parseCacheLifeOverrides("pi=0,bad,x=y,codex=5"), { codex: 5 * MINUTE });
  assert.match(cacheLifeOverridesProblem("pi=360,oops") ?? "", /"oops" is not provider=minutes/);
  assert.equal(cacheLifeOverridesProblem(""), null);
  assert.equal(cacheLifeOverridesProblem("pi=360"), null);
});

test("a title names its issue by TEAM-NNNN or NNNN:", () => {
  assert.equal(titleIdentifier("TEAM-1678 thread work", "TEAM"), "TEAM-1678");
  assert.equal(titleIdentifier("1678: thread work", "TEAM"), "TEAM-1678");
  assert.equal(titleIdentifier("Coder: TEAM-1678", "TEAM"), null);
  assert.equal(titleIdentifier("no number", "TEAM"), null);
});

test("a signed claim names a thread", () => {
  assert.equal(claimThread("[agent:claude-code thr_abc1] claim: taking it"), "thr_abc1");
  assert.equal(claimThread("[agent:claude-code thr_abc1]\nclaim: taking it"), "thr_abc1");
  assert.equal(claimThread("[agent:claude-code thr_abc1] done"), null);
  assert.equal(claimThread("claim: unsigned"), null);
});

test("a claim beats the title prefix; the latest claim wins; the prefix is the fallback", () => {
  const make = (identifier: string, comments: IssueWithComments["comments"]): IssueWithComments => ({
    ...issue("In Progress", "started", { identifier }),
    comments,
  });
  const issues = [
    make("TEAM-1", [{ body: "[agent:claude-code thr_a] claim: one", createdAt: 1 }]),
    make("TEAM-2", [{ body: "[agent:claude-code thr_a] claim: two", createdAt: 2 }]),
    make("TEAM-1678", []),
  ];
  assert.equal(issueFor({ id: "thr_a", title: "1678: x" }, issues, "TEAM")?.identifier, "TEAM-2");
  assert.equal(issueFor({ id: "thr_b", title: "1678: x" }, issues, "TEAM")?.identifier, "TEAM-1678");
  assert.equal(issueFor({ id: "thr_b", title: "nothing" }, issues, "TEAM"), null);
});
