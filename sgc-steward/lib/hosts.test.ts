import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDigest, formatHosts, hostsDigest, hostsView, waitText } from "./hosts.ts";
import { parseLimitStatus } from "./hosts-read.ts";
import { EXPECTED_HOSTS, EXPECTED_UNPLACED, LIMITS, LIMITS_JSON, MINUTE, NOW, input } from "../test-support-hosts.ts";

test("each of the five hosts shows its own state in the view model", () => {
  const view = hostsView(input());
  assert.deepEqual(view.hosts, EXPECTED_HOSTS);
  assert.deepEqual(view.unplaced, EXPECTED_UNPLACED);
  assert.equal(view.checkedAt, NOW);
  assert.equal(view.globalLimit, null);
  assert.equal(view.globalAtLimit, false);
  assert.equal(view.running, 10, "every running thread, on a host or not");
  assert.equal(view.limitError, null);
});

test("a thread with several rows held is one waiting turn, as old as its oldest row", () => {
  const view = hostsView(input({ waiting: [
    { threadId: "thr_w3", createdAt: NOW - 5 * MINUTE, hostId: "host_wait" },
    { threadId: "thr_w3", createdAt: NOW - 14 * MINUTE, hostId: "host_wait" },
  ] }));
  const host = view.hosts.find((row) => row.id === "host_wait")!;
  assert.equal(host.waiting, 1);
  assert.equal(host.oldestWaitMs, 14 * MINUTE);
});

test("a host bb no longer lists keeps its threads in the unplaced counts", () => {
  const view = hostsView(input({ running: [{ id: "thr_gone", hostId: "host_gone" }], idle: [{ key: "host_gone", count: 2 }], waiting: [] }));
  assert.deepEqual(view.unplaced, { running: 1, idle: 2, waiting: 0, oldestWaitSince: null, oldestWaitMs: null });
});

test("without the limits, the counts still show and no host is called at its limit", () => {
  const view = hostsView(input({ limits: null, limitError: "bb concurrency-limit status failed: no bb" }));
  assert.equal(view.limitError, "bb concurrency-limit status failed: no bb");
  for (const host of view.hosts) {
    assert.deepEqual([host.limit, host.limitSource, host.automaticLimit, host.atLimit], [null, null, null, false], host.name);
  }
  assert.deepEqual(
    view.hosts.map((host) => [host.name, host.running, host.idle, host.waiting]),
    EXPECTED_HOSTS.map((host) => [host.name, host.running, host.idle, host.waiting]),
  );
});

test("a host the limits do not list has no limit", () => {
  const limits = { ...LIMITS, hosts: LIMITS.hosts.filter((host) => host.id !== "host_auto") };
  const host = hostsView(input({ limits })).hosts.find((row) => row.id === "host_auto")!;
  assert.deepEqual([host.limit, host.limitSource, host.atLimit], [null, null, false]);
});

test("a limit of 0 pauses the host, so it is at its limit with nothing running", () => {
  const limits = { ...LIMITS, hosts: LIMITS.hosts.map((host) => (host.id === "host_down" ? { ...host, effectiveLimit: 0, override: 0 } : host)) };
  const host = hostsView(input({ limits })).hosts.find((row) => row.id === "host_down")!;
  assert.deepEqual([host.running, host.limit, host.limitSource, host.atLimit], [0, 0, "override", true]);
});

test("the global limit is reached when every running thread together meets it", () => {
  assert.equal(hostsView(input({ limits: { ...LIMITS, globalLimit: 10 } })).globalAtLimit, true);
  assert.equal(hostsView(input({ limits: { ...LIMITS, globalLimit: 11 } })).globalAtLimit, false);
});

test("the digest names the hosts at their limit and the hosts with waiting turns, with the oldest wait", () => {
  const digest = hostsDigest(hostsView(input()));
  assert.deepEqual(digest.atLimit, [
    { id: "host_at", name: "at", running: 4, limit: 4, limitSource: "override" },
    { id: "host_wait", name: "waiting", running: 2, limit: 2, limitSource: "override" },
  ]);
  assert.deepEqual(digest.waiting, [
    { id: "host_wait", name: "waiting", waiting: 2, oldestWaitSince: NOW - 14 * MINUTE, oldestWaitMs: 14 * MINUTE },
    { id: null, name: "(no host)", waiting: 1, oldestWaitSince: NOW - MINUTE, oldestWaitMs: MINUTE },
  ]);
  assert.deepEqual([digest.globalAtLimit, digest.limitError, digest.checkedAt], [false, null, NOW]);
});

test("the digest text says each flag on one line, and says so when there is none", () => {
  assert.equal(
    formatDigest(hostsDigest(hostsView(input()))),
    ["At their limit: at 4/4 (override), waiting 2/2 (override).", "Waiting on the limit: waiting 2, oldest 14 min; (no host) 1, oldest 1 min."].join("\n"),
  );
  const quiet = hostsView(input({ running: [], waiting: [] }));
  assert.equal(formatDigest(hostsDigest(quiet)), "No host is at its limit, and no turn waits on one.");
  const blind = hostsView(input({ running: [], waiting: [], limits: null, limitError: "no bb" }));
  assert.equal(formatDigest(hostsDigest(blind)), "No turn waits on a limit.\nCould not read the limits: no bb");
  const global = hostsView(input({ limits: { ...LIMITS, globalLimit: 10 } }));
  assert.match(formatDigest(hostsDigest(global)), /^The global limit of 10 is reached: 10 running\.$/m);
});

test("the text table has a row per host, the unplaced threads, and the global limit", () => {
  assert.equal(
    formatHosts(hostsView(input())),
    [
      "Host       ID          Status        Running  Idle  Waiting  Oldest wait  Limit",
      "at         host_at     connected     4        1     0        -            4 (override), at limit",
      "auto       host_auto   connected     3        0     0        -            8 (automatic)",
      "down       host_down   disconnected  0        2     0        -            12 (automatic)",
      "under      host_under  connected     1        3     0        -            4 (override)",
      "waiting    host_wait   connected     2        2     2        14 min       2 (override), at limit",
      "(no host)  -           -             0        1     1        1 min        -",
      "",
      "Global limit: none. Running: 10.",
    ].join("\n"),
  );
});

test("a wait reads in seconds, minutes, or hours and minutes", () => {
  assert.deepEqual([waitText(null), waitText(40_000), waitText(14 * MINUTE), waitText(135 * MINUTE)], ["-", "40 s", "14 min", "2 h 15 min"]);
});

test("the limits parse from bb's own JSON, and anything else is refused with what was wrong", () => {
  assert.deepEqual(parseLimitStatus(LIMITS_JSON), LIMITS);
  assert.throws(() => parseLimitStatus("not json"), /not JSON/);
  assert.throws(() => parseLimitStatus(JSON.stringify({ globalLimit: null, hosts: [{ id: "host_x" }] })), /unexpected shape/);
});
