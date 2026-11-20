import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR, MINUTE } from "./lifecycle.ts";
import {
  attentionCount,
  buttonRefusal,
  groupByHost,
  lastAction,
  rowText,
  summarize,
  summaryText,
  tokensText,
  type DecisionRow,
  type ThreadRowView,
  type ThreadsView,
} from "./threads-view.ts";
import { threadsBadge } from "./panel.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");

function row(id: string, extra: Partial<ThreadRowView> = {}): ThreadRowView {
  return {
    id,
    title: `Title ${id}`,
    state: "idle-active",
    stateReason: "x",
    issue: { identifier: "TEAM-7", url: "https://linear.app/ws/issue/TEAM-7", stateName: "In Progress" },
    provider: "claude-code",
    model: "opus",
    hostId: "host_a",
    hostName: "spark-d",
    environmentId: "env_a",
    usedTokens: 150_000,
    contextWindow: 1_000_000,
    lastActivityAt: NOW - 50 * MINUTE,
    expiresAt: NOW + 10 * MINUTE,
    expiresSource: "provider-table",
    expiresIn: "10m",
    inWindow: true,
    decision: "compact",
    reason: "150000 tokens and TEAM-7 is open",
    ...extra,
  };
}

function view(threads: ThreadRowView[], extra: Partial<ThreadsView> = {}): ThreadsView {
  return { checkedAt: NOW, mode: "observe", linearError: null, threads, ...extra };
}

function entry(threadId: string, decision: DecisionRow["decision"], result: DecisionRow["result"], at: number, extra: Partial<DecisionRow> = {}): DecisionRow {
  return { id: at, at, threadId, threadTitle: "t", decision, state: "done", reason: "r", result, inputs: {}, ...extra };
}

test("the countdown reads in minutes and hours, and cold once past, live from the clock", () => {
  const thread = row("thr_a", { expiresAt: NOW + 65 * MINUTE });
  assert.equal(rowText(thread, NOW, []).expires, "1h 5m");
  assert.equal(rowText(thread, NOW + 30 * MINUTE, []).expires, "35m");
  assert.equal(rowText(thread, NOW + 65 * MINUTE, []).expires, "cold");
  assert.equal(rowText(thread, NOW + 2 * HOUR, []).expires, "cold");
});

test("a row shows its title, state, issue link, provider/model, tokens, decision, and reason", () => {
  const text = rowText(row("thr_a"), NOW, []);
  assert.equal(text.title, "Title thr_a");
  assert.equal(text.state, "idle-active");
  assert.deepEqual(text.issue, { identifier: "TEAM-7", href: "linear://ws/issue/TEAM-7" });
  assert.equal(text.providerModel, "claude-code/opus");
  assert.equal(text.tokens, "150k / 1.0M");
  assert.equal(text.decision, "compact");
  assert.match(text.reason, /TEAM-7 is open/);
});

test("a row with nothing known shows dashes, and the thread id for a thread with no title", () => {
  const text = rowText(row("thr_a", { title: "", issue: null, model: null, usedTokens: null, contextWindow: null }), NOW, []);
  assert.deepEqual([text.title, text.issue, text.providerModel, text.tokens], ["thr_a", null, "claude-code/?", "-"]);
});

test("each state shows a label and a tone", () => {
  const states = ["working", "waiting", "idle-active", "parked", "done", "orphan", "stuck", "protected"] as const;
  const tones = Object.fromEntries(states.map((state) => [state, rowText(row("thr_a", { state }), NOW, []).stateTone]));
  assert.deepEqual(tones, {
    working: "active",
    waiting: "active",
    "idle-active": "neutral",
    parked: "quiet",
    done: "quiet",
    orphan: "warning",
    stuck: "critical",
    protected: "quiet",
  });
});

test("tokens read as used / window, in k and M", () => {
  assert.equal(tokensText(950, 200_000), "950 / 200k");
  assert.equal(tokensText(1_250_000, 2_000_000), "1.3M / 2.0M");
  assert.equal(tokensText(5000, null), "5k / ?");
  assert.equal(tokensText(null, 200_000), "-");
});

test("threads group by host, each group sorted by cache expiry, soonest first; threads with no host last", () => {
  const groups = groupByHost([
    row("thr_late", { expiresAt: NOW + 50 * MINUTE }),
    row("thr_b1", { hostId: "host_b", hostName: "mba-15", expiresAt: NOW + 5 * MINUTE }),
    row("thr_soon", { expiresAt: NOW + 2 * MINUTE }),
    row("thr_none", { hostId: null, hostName: null, expiresAt: NOW - HOUR }),
    row("thr_cold", { expiresAt: NOW - 3 * MINUTE }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.threads.map((thread) => thread.id)]),
    [
      ["mba-15", ["thr_b1"]],
      ["spark-d", ["thr_cold", "thr_soon", "thr_late"]],
      ["(no host)", ["thr_none"]],
    ],
  );
});

test("a host with no name shows its id", () => {
  assert.equal(groupByHost([row("thr_a", { hostName: null })])[0]!.name, "host_a");
});

test("the summary counts threads by state, and those going cold in 15 minutes, and tokens held cold", () => {
  const summary = summarize(
    view([
      row("thr_a", { state: "idle-active", expiresAt: NOW + 10 * MINUTE }),
      row("thr_b", { state: "done", expiresAt: NOW + 15 * MINUTE }),
      row("thr_c", { state: "done", expiresAt: NOW + 16 * MINUTE }),
      row("thr_d", { state: "stuck", expiresAt: NOW - MINUTE, usedTokens: 200_000 }),
      row("thr_e", { state: "idle-active", expiresAt: NOW - HOUR, usedTokens: 300_000 }),
      // A running thread is not cold, whatever its clock says.
      row("thr_f", { state: "working", expiresAt: NOW - HOUR, usedTokens: 900_000 }),
      row("thr_g", { state: "parked", expiresAt: NOW - HOUR, usedTokens: null }),
    ]),
    NOW,
  );
  assert.deepEqual(summary.counts, { working: 1, "idle-active": 2, done: 2, stuck: 1, parked: 1 });
  assert.equal(summary.goingCold, 2);
  assert.equal(summary.coldTokens, 500_000);
  assert.equal(summary.mode, "observe");
});

test("the summary line names the counts, the cooling threads, the cold tokens, and the mode", () => {
  const text = summaryText(
    summarize(view([row("thr_a", { state: "done" }), row("thr_b", { state: "idle-active", expiresAt: NOW - MINUTE, usedTokens: 1_500_000 })]), NOW),
  );
  assert.equal(text, "2 threads: 1 idle-active, 1 done. 1 going cold in the next 15 minutes. 1.5M tokens held in cold threads. Mode: observe.");
  assert.equal(summaryText(summarize(view([], { mode: "act" }), NOW)), "0 threads. 0 going cold in the next 15 minutes. 0 tokens held in cold threads. Mode: act.");
});

test("the badge counts threads that need attention: stuck or flagged", () => {
  const v = view([
    row("thr_a", { state: "stuck", decision: "flag" }),
    row("thr_b", { state: "orphan", decision: "flag" }),
    row("thr_c", { state: "done", decision: "flag" }),
    row("thr_d", { state: "stuck", decision: "none" }),
    row("thr_e", { state: "idle-active", decision: "compact" }),
  ]);
  assert.equal(attentionCount(v), 4);
  assert.deepEqual(threadsBadge(v), { count: 4, alert: false });
  assert.deepEqual(threadsBadge(null), { count: 0, alert: false });
  assert.deepEqual(threadsBadge(view([], { linearError: "down" })), { count: 0, alert: true });
});

test("the last action of a thread is its newest log entry, with how long ago", () => {
  const log = [
    entry("thr_a", "archive", "done", NOW - 5 * MINUTE),
    entry("thr_b", "compact", "observed", NOW - 20 * MINUTE),
    entry("thr_a", "compact", "observed", NOW - HOUR),
  ];
  assert.equal(lastAction("thr_a", log, NOW), "archive done 5m ago");
  assert.equal(lastAction("thr_b", log, NOW), "compact observed 20m ago");
  assert.equal(lastAction("thr_c", log, NOW), "-");
  assert.equal(lastAction("thr_a", [entry("thr_a", "archive", "failed", NOW - MINUTE, { error: "boom" })], NOW), "archive failed 1m ago");
});

test("the buttons refuse a thread that cannot take them, with the reason", () => {
  assert.equal(buttonRefusal(row("thr_a"), "compact"), null);
  assert.equal(buttonRefusal(row("thr_a"), "archive"), null);
  assert.equal(buttonRefusal(row("thr_a"), "keep"), null);
  assert.equal(buttonRefusal(row("thr_a", { state: "protected" }), "archive"), "Protected threads are never archived or compacted.");
  assert.equal(buttonRefusal(row("thr_a", { state: "protected" }), "compact"), "Protected threads are never archived or compacted.");
  assert.equal(buttonRefusal(row("thr_a", { state: "protected" }), "keep"), "Already protected.");
  assert.equal(buttonRefusal(row("thr_a", { state: "working" }), "archive"), "A turn is running. Wait until the thread is idle.");
  assert.equal(buttonRefusal(row("thr_a", { state: "working" }), "compact"), "A turn is running. Wait until the thread is idle.");
  assert.equal(buttonRefusal(row("thr_a", { state: "waiting" }), "compact"), "The thread has a queued message or a child at work. Wait until it is idle.");
  assert.equal(buttonRefusal(row("thr_a", { state: "stuck" }), "compact"), null);
  // Keep is allowed on a running thread: it only stops the plugin touching it.
  assert.equal(buttonRefusal(row("thr_a", { state: "working" }), "keep"), null);
});
