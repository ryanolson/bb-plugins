import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostsDigest, HostsView } from "./lib/hosts.ts";
import { LIMIT_STATUS_ARGS, readOnlyBb } from "./lib/hosts-read.ts";
import { setup } from "./test-support.ts";
import { EXPECTED_HOSTS, EXPECTED_UNPLACED, HOSTS, IDLE, LIMITS_JSON, MINUTE, NOW, QUEUE, RUNNING, THREADS } from "./test-support-hosts.ts";

/** The only reads the Hosts view may make of bb's SDK. */
const SDK_READS = new Set(["hosts.list", "threads.listRunning", "threads.count", "threads.queue.list", "threads.list"]);

/** The plugin on the fake bb state, with every bb CLI run it makes recorded. */
async function hostsSetup(options: { limits?: () => Promise<string> } = {}) {
  const bbRuns: string[][] = [];
  const { harness } = await setup({
    runBb: async (args) => {
      bbRuns.push([...args]);
      return options.limits === undefined ? LIMITS_JSON : options.limits();
    },
    now: () => NOW,
  });
  const sdk = harness.inspection.sdk;
  sdk.stub("hosts.list", async () => HOSTS.map((host) => ({ ...host })));
  sdk.stub("threads.listRunning", async () => RUNNING.map((row) => ({ ...row })));
  sdk.stub("threads.count", async (args: unknown) => {
    const { status, groupBy } = args as { status?: string; groupBy?: string };
    assert.deepEqual([status, groupBy], ["idle", "host"]);
    return structuredClone(IDLE);
  });
  sdk.stub("threads.queue.list", async (args: unknown) => {
    const { waitHolder } = (args ?? {}) as { waitHolder?: string };
    // As bb filters on the row's wait holder: the plugin that owns its waitingOn.
    const holder = (row: (typeof QUEUE)[number]) => (row.waitingOn.kind === "plugin" ? `plugin:${row.waitingOn.pluginId}` : null);
    return QUEUE.filter((row) => waitHolder === undefined || holder(row) === waitHolder).map((row) => structuredClone(row));
  });
  sdk.stub("threads.list", async (args: unknown) => {
    const { threadIds } = args as { threadIds: string[] };
    return THREADS.filter((thread) => threadIds.includes(thread.id)).map((thread) => ({ ...thread }));
  });
  const from = sdk.calls.length;
  const sdkCalls = () => sdk.calls.slice(from);
  return { harness, bbRuns, sdkCalls };
}

test("bb sgc hosts --json shows each of the five hosts correctly", async () => {
  const { harness } = await hostsSetup();
  const result = await harness.behavior.runCli(["hosts", "--json"], { threadId: "thr_steward" });
  assert.equal(result.exitCode, 0, result.stderr);
  const view = JSON.parse(result.stdout) as HostsView;
  assert.deepEqual(view.hosts, EXPECTED_HOSTS);
  assert.deepEqual(view.unplaced, EXPECTED_UNPLACED);
  assert.deepEqual([view.checkedAt, view.globalLimit, view.globalAtLimit, view.running, view.limitError], [NOW, null, false, 10, null]);
});

test("the panel's hosts.list returns the same view model as the CLI JSON", async () => {
  const { harness } = await hostsSetup();
  const cli = JSON.parse((await harness.behavior.runCli(["hosts", "--json"], {})).stdout) as HostsView;
  const rpc = (await harness.behavior.callRpc("hosts.list", null)) as HostsView;
  assert.deepEqual(rpc, cli);
  assert.deepEqual(rpc.hosts, EXPECTED_HOSTS);
});

test("only the threads the limit holds are looked up, and only their host places them", async () => {
  const { harness, sdkCalls } = await hostsSetup();
  await harness.behavior.runCli(["hosts", "--json"], {});
  const queueReads = sdkCalls().filter((call) => call.path === "threads.queue.list");
  assert.deepEqual(queueReads.map((call) => (call.args[0] as { waitHolder?: string }).waitHolder), ["plugin:concurrency-limit"]);
  const looked = sdkCalls()
    .filter((call) => call.path === "threads.list")
    .flatMap((call) => (call.args[0] as { threadIds: string[] }).threadIds);
  assert.deepEqual([...looked].sort(), ["thr_new", "thr_w3", "thr_w4"]);
});

test("bb sgc hosts prints the table", async () => {
  const { harness } = await hostsSetup();
  const result = await harness.behavior.runCli(["hosts"], {});
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^waiting {4}host_wait {3}connected {5}2 {8}2 {5}2 {8}14 min {7}2 \(override\), at limit$/m);
  assert.match(result.stdout, /^down {7}host_down {3}disconnected {2}0 {8}2 {5}0 {8}- {12}12 \(automatic\)$/m);
});

test("bb sgc hosts --digest names the hosts at their limit and the waiting turns, in text and JSON", async () => {
  const { harness } = await hostsSetup();
  const text = await harness.behavior.runCli(["hosts", "--digest"], {});
  assert.equal(text.exitCode, 0, text.stderr);
  assert.equal(
    text.stdout,
    "At their limit: at 4/4 (override), waiting 2/2 (override).\nWaiting on the limit: waiting 2, oldest 14 min; (no host) 1, oldest 1 min.",
  );
  const json = JSON.parse((await harness.behavior.runCli(["hosts", "--digest", "--json"], {})).stdout) as HostsDigest;
  assert.deepEqual(
    json.atLimit.map((host) => host.name),
    ["at", "waiting"],
  );
  assert.deepEqual(json.waiting, [
    { id: "host_wait", name: "waiting", waiting: 2, oldestWaitSince: NOW - 14 * MINUTE, oldestWaitMs: 14 * MINUTE },
    { id: null, name: "(no host)", waiting: 1, oldestWaitSince: NOW - MINUTE, oldestWaitMs: MINUTE },
  ]);
});

test("the Hosts view never runs a write: only SDK reads, and only bb concurrency-limit status", async () => {
  const { harness, bbRuns, sdkCalls } = await hostsSetup();
  for (const argv of [["hosts"], ["hosts", "--json"], ["hosts", "--digest"], ["hosts", "--digest", "--json"]]) {
    assert.equal((await harness.behavior.runCli(argv, {})).exitCode, 0, argv.join(" "));
  }
  await harness.behavior.callRpc("hosts.list", null);
  assert.ok(sdkCalls().length > 0, "the control: the reads were recorded");
  assert.deepEqual(
    sdkCalls().filter((call) => !SDK_READS.has(call.path)).map((call) => call.path),
    [],
    "an SDK call outside the reads",
  );
  assert.equal(bbRuns.length, 5);
  for (const args of bbRuns) assert.deepEqual(args, [...LIMIT_STATUS_ARGS]);
});

test("the bb runner refuses any command but the limit status, before it runs", async () => {
  const runs: string[][] = [];
  const bb = readOnlyBb(async (args) => (runs.push([...args]), "{}"));
  for (const args of [
    ["concurrency-limit", "host", "host_at", "9"],
    ["concurrency-limit", "global", "4"],
    ["concurrency-limit", "status"],
    ["concurrency-limit", "status", "--json", "--host", "x"],
  ]) {
    await assert.rejects(bb(args), /read only/, args.join(" "));
  }
  assert.deepEqual(runs, []);
  assert.equal(await bb([...LIMIT_STATUS_ARGS]), "{}");
  assert.deepEqual(runs, [[...LIMIT_STATUS_ARGS]]);
});

test("when the limits cannot be read, the counts still show, without limits, and the command exits 1", async () => {
  const { harness } = await hostsSetup({ limits: async () => Promise.reject(new Error("spawn bb ENOENT")) });
  const result = await harness.behavior.runCli(["hosts", "--json"], {});
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Could not read the limits: .*spawn bb ENOENT/);
  const view = JSON.parse(result.stdout) as HostsView;
  assert.match(view.limitError ?? "", /spawn bb ENOENT/);
  assert.deepEqual(
    view.hosts.map((host) => [host.name, host.running, host.idle, host.waiting, host.limit, host.atLimit]),
    EXPECTED_HOSTS.map((host) => [host.name, host.running, host.idle, host.waiting, null, false]),
  );
  const rpc = (await harness.behavior.callRpc("hosts.list", null)) as HostsView;
  assert.match(rpc.limitError ?? "", /spawn bb ENOENT/, "the panel shows the same trouble");
});

test("limits that are not bb's JSON are a limit error, not a crash", async () => {
  const { harness } = await hostsSetup({ limits: async () => "Error: unknown command" });
  const result = await harness.behavior.runCli(["hosts", "--json"], {});
  assert.equal(result.exitCode, 1);
  assert.match((JSON.parse(result.stdout) as HostsView).limitError ?? "", /not JSON/);
});
