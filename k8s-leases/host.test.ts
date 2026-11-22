// The host entry against a fake `k8s-guard` and a fake `bb`, both scripts
// on a PATH that holds nothing else, so no test can reach a real bb server
// or a real cluster.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createHostEntry } from "./host.ts";

let dir = "";
let log = "";
const savedPath = process.env.PATH;

const RUN = { command: "k8s-guard", serverUrl: "http://127.0.0.1:38900", kubeconfig: "/home/test/.kube/bot.yaml" };
const UID = "00000000-0000-4000-8000-000000000001";

/** A script that logs its argv and the env it was given, then acts on FAKE_MODE. */
function script(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), server: process.env.BB_SERVER_URL ?? null, kubeconfig: process.env.KUBECONFIG ?? null }) + "\\n");
const mode = process.env.FAKE_MODE ?? "ok";
${body}
`,
  );
  chmodSync(path, 0o755);
}

function calls(): Array<{ name: string; argv: string[]; server: string | null; kubeconfig: string | null }> {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "k8s-leases-host-test-"));
  log = join(dir, "calls.jsonl");
  script(
    "k8s-guard",
    `
if (mode === "not_found") { process.stdout.write(JSON.stringify({ error: "namespace dyntest-a not found", code: "not_found" })); process.exit(3); }
if (mode === "fail") { process.stdout.write(JSON.stringify({ error: "the API refused" })); process.exit(1); }
if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
if (mode === "hang") { setTimeout(() => {}, 60000); return; }
if (process.argv[2] === "fence" && mode === "probe_bad") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", canary: "maybe", mode: "enforcing", scope: "finegrained", armed: true, lease_fence: "true", canary_text: "x", mode_text: "y" }));
} else if (process.argv[2] === "fence" && mode === "probe_off") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", canary: "disarmed", mode: "absent", mode_entry: null, scope: "unknown", armed: false, cause: "no fence webhook answered", lease_fence: "true", canary_text: "created (dry run)", mode_text: "created (dry run)" }));
} else if (process.argv[2] === "fence") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", canary: "finegrained", mode: "enforcing", mode_entry: "finegrained", scope: "finegrained", armed: true, lease_fence: "true", canary_text: "denied by validate.kyverno.svc-fail-finegrained-agent-lease-fence-canary", mode_text: "pods-need-the-open-lease", extra: 1 }));
} else if (process.argv[2] === "down" && mode === "claimed_complete") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", lease_id: "lse_test000001", complete: true, namespace_kept: true, deleted: [], resolutions: [], fence: { lease_id: "lse_test000001", seq: 7, state: "closing" }, drain_monotonic_seconds: 120.5, max_probe_gap_seconds: 5.5, armed: "continuous", lease_fence: "true", probes: 26 }));
} else if (process.argv[2] === "down" && mode === "claimed_malformed") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", lease_id: "lse_test000001", complete: true, resolutions: [], fence: { lease_id: "lse_test000001", seq: "7", state: "closing" }, drain_monotonic_seconds: "120", max_probe_gap_seconds: "5", armed: "always", lease_fence: 1 }));
} else if (process.argv[2] === "down" && mode === "claimed_disarmed") {
  process.stdout.write(JSON.stringify({ error: "a probe in the drain read disarmed", code: "teardown_incomplete", resolutions: [], fence_disarmed: true, probe: { canary: "disarmed", mode: "absent", scope: "unknown", armed: false, cause: "no fence webhook answered", canary_text: "created (dry run)", mode_text: "created (dry run)", extra: 1 } }));
  process.exit(4);
} else if (process.argv[2] === "down" && mode === "claimed_disarmed_bad") {
  process.stdout.write(JSON.stringify({ error: "a probe in the drain read disarmed", code: "teardown_incomplete", fence_disarmed: "yes", probe: { canary: "disarmed" } }));
  process.exit(4);
} else if (process.argv[2] === "inspect") {
  process.stdout.write(JSON.stringify({ uid: ${JSON.stringify(UID)}, thread: "thr_aaaa1111", expires_at: "2026-11-05T12:00:00Z", dgd_gpus: 4, pod_gpus: 2, gpu_type: "gb300", gpu_pods_left: 1, extra: true }));
} else if (process.argv[2] === "down") {
  process.stdout.write(JSON.stringify({ namespace: "dyntest-a", deleted: true, terminating: true, gpu_pods_left: 2, authority: "lease lse_test000001 is releasing" }));
} else {
  process.stdout.write(JSON.stringify({ done: process.argv[2] }));
}
`,
  );
  script(
    "bb",
    `
if (mode === "bb_down") { process.stderr.write("Error: Cannot connect to BB server."); process.exit(1); }
process.stdout.write("[]");
`,
  );
  script(
    "k8s-check",
    `
if (mode === "profiles_bad") { process.stdout.write(JSON.stringify({ failures: [{ code: "profiles_invalid", message: "unknown key gpu_typo" }] })); process.exit(1); }
process.stdout.write(JSON.stringify({ schema_version: 1, bot: { user: "bot-x" }, clusters: { "lab-a": { context: "proxy.example.test-lab-a", allowed: "first-choice", source: ["t"], bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 } } }));
`,
  );
  process.env.PATH = dir;
});

beforeEach(() => {
  rmSync(log, { force: true });
  delete process.env.FAKE_MODE;
});

after(() => {
  process.env.PATH = savedPath;
  if (dir.startsWith(join(tmpdir(), "k8s-leases-host-test-"))) rmSync(dir, { recursive: true, force: true });
});

const target = { run: RUN, context: "test-context-a", namespace: "dyntest-a" };
const leaseTarget = { ...target, uid: UID, leaseId: "lse_test000001" };

test("inspect runs the guard with an explicit --context, and the bb server URL and kubeconfig", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  const result = await harness.experimental_call("inspect", target);
  assert.deepEqual(result, {
    ok: true,
    value: { uid: UID, thread: "thr_aaaa1111", expires_at: "2026-11-05T12:00:00Z", dgd_gpus: 4, pod_gpus: 2, gpu_type: "gb300", gpu_pods_left: 1 },
  });
  assert.deepEqual(calls(), [{ name: "k8s-guard", argv: ["inspect", "--context", "test-context-a", "dyntest-a"], server: RUN.serverUrl, kubeconfig: RUN.kubeconfig }]);
  await harness.experimental_dispose();
});

test("expire, down and extend pass the namespace UID and the lease", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  assert.deepEqual(await harness.experimental_call("expire", leaseTarget), { ok: true });
  // down started the deletion; it reports the GPU pods still terminating.
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), { ok: true, terminating: true, gpu_pods_left: 2 });
  assert.deepEqual(await harness.experimental_call("extend", leaseTarget), { ok: true });
  assert.deepEqual(
    calls().map((c) => c.argv),
    ["expire", "down", "extend"].map((m) => [m, "--context", "test-context-a", "dyntest-a", "--uid", UID, "--lease", "lse_test000001"]),
  );
  await harness.experimental_dispose();
});

test("a guard failure keeps its code: not_found is not a lookup failure", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  process.env.FAKE_MODE = "not_found";
  assert.deepEqual(await harness.experimental_call("inspect", target), { ok: false, code: "not_found", error: "namespace dyntest-a not found" });
  process.env.FAKE_MODE = "fail";
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), { ok: false, code: "guard_error", error: "the API refused" });
  process.env.FAKE_MODE = "garbage";
  const garbage = (await harness.experimental_call("inspect", target)) as { ok: boolean; code: string };
  assert.equal(garbage.ok, false);
  assert.equal(garbage.code, "guard_output");
  await harness.experimental_dispose();
});

test("a guard that hangs is stopped at the deadline", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry({ timeoutMs: { inspect: 300, expire: 300, down: 300, extend: 300, probe: 300 } }));
  process.env.FAKE_MODE = "hang";
  const result = (await harness.experimental_call("expire", leaseTarget)) as { ok: boolean; code: string };
  assert.deepEqual([result.ok, result.code], [false, "guard_timeout"]);
  await harness.experimental_dispose();
});

test("names that could read as flags are refused before any process runs", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  await assert.rejects(harness.experimental_call("inspect", { ...target, namespace: "--all-namespaces" }));
  await assert.rejects(harness.experimental_call("inspect", { ...target, context: "-A" }));
  await assert.rejects(harness.experimental_call("down", { ...leaseTarget, uid: "--force" }));
  assert.deepEqual(calls(), []);
  await harness.experimental_dispose();
});

test("probe: the guard on PATH and bb reaching the plugin, with the same environment", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  assert.deepEqual(await harness.experimental_call("probe", { run: RUN }), { ok: true, detail: "ok" });
  assert.deepEqual(calls(), [{ name: "bb", argv: ["k8s", "leases", "--json"], server: RUN.serverUrl, kubeconfig: RUN.kubeconfig }]);
  process.env.FAKE_MODE = "bb_down";
  const down = (await harness.experimental_call("probe", { run: RUN })) as { ok: boolean; detail: string };
  assert.equal(down.ok, false);
  assert.match(down.detail, /bb/);
  delete process.env.FAKE_MODE;
  const missing = (await harness.experimental_call("probe", { run: { ...RUN, command: "no-such-guard" } })) as { ok: boolean; detail: string };
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /no-such-guard/);
  await harness.experimental_dispose();
});

test("an unset kubeconfig is not passed; the guard inherits KUBECONFIG", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  process.env.KUBECONFIG = "/inherited/config";
  try {
    await harness.experimental_call("inspect", { ...target, run: { ...RUN, kubeconfig: null } });
  } finally {
    delete process.env.KUBECONFIG;
  }
  assert.equal(calls()[0]!.kubeconfig, "/inherited/config");
  await harness.experimental_dispose();
});

test("profiles: k8s-check --list, with ~ expanded, and its failure code kept", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  const savedHome = process.env.HOME;
  process.env.HOME = dir.slice(0, dir.lastIndexOf("/"));
  try {
    const command = `~/${dir.slice(dir.lastIndexOf("/") + 1)}/k8s-check`;
    const read = (await harness.experimental_call("profiles", { command })) as { ok: boolean; value?: { clusters: Record<string, { context: string }> } };
    assert.equal(read.ok, true);
    assert.equal(read.value!.clusters["lab-a"]!.context, "proxy.example.test-lab-a");
    assert.deepEqual(calls().at(-1)!.argv, ["--list"]);
    process.env.FAKE_MODE = "profiles_bad";
    assert.deepEqual(await harness.experimental_call("profiles", { command }), { ok: false, code: "profiles_invalid", error: "unknown key gpu_typo" });
  } finally {
    process.env.HOME = savedHome;
  }
  const missing = (await harness.experimental_call("profiles", { command: "/no/such/k8s-check" })) as { ok: boolean; code: string };
  assert.deepEqual([missing.ok, missing.code], [false, "profiles_reader_missing"]);
  await harness.experimental_dispose();
});

test("a guard command under ~ is expanded for the probe and for every guard call", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  const savedHome = process.env.HOME;
  process.env.HOME = dir.slice(0, dir.lastIndexOf("/"));
  try {
    const run = { ...RUN, command: `~/${dir.slice(dir.lastIndexOf("/") + 1)}/k8s-guard` };
    assert.deepEqual(await harness.experimental_call("probe", { run }), { ok: true, detail: "ok" });
    const result = (await harness.experimental_call("inspect", { ...target, run })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.deepEqual(calls().at(-1)!.argv, ["inspect", "--context", "test-context-a", "dyntest-a"]);
  } finally {
    process.env.HOME = savedHome;
  }
  await harness.experimental_dispose();
});

test("probe-fence runs `fence probe` with the context and the namespace, and no UID or lease", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  assert.deepEqual(await harness.experimental_call("probe-fence", target), {
    ok: true,
    value: {
      namespace: "dyntest-a",
      canary: "finegrained",
      mode: "enforcing",
      mode_entry: "finegrained",
      scope: "finegrained",
      armed: true,
      lease_fence: "true",
      canary_text: "denied by validate.kyverno.svc-fail-finegrained-agent-lease-fence-canary",
      mode_text: "pods-need-the-open-lease",
    },
  });
  // A fence not armed carries its cause.
  process.env.FAKE_MODE = "probe_off";
  const off = (await harness.experimental_call("probe-fence", target)) as { ok: true; value: { armed: boolean; cause?: string; mode_entry: unknown } };
  assert.deepEqual([off.value.armed, off.value.cause, off.value.mode_entry], [false, "no fence webhook answered", null]);
  assert.deepEqual(calls().map((c) => c.argv), [["fence", "probe", "--context", "test-context-a", "dyntest-a"], ["fence", "probe", "--context", "test-context-a", "dyntest-a"]]);
  // A verdict outside the contract is no answer.
  process.env.FAKE_MODE = "probe_bad";
  const bad = (await harness.experimental_call("probe-fence", target)) as { ok: boolean; code: string };
  assert.deepEqual([bad.ok, bad.code], [false, "guard_output"]);
  process.env.FAKE_MODE = "not_found";
  assert.deepEqual(await harness.experimental_call("probe-fence", target), { ok: false, code: "not_found", error: "namespace dyntest-a not found" });
  // The probe takes no lease target.
  await assert.rejects(harness.experimental_call("probe-fence", leaseTarget as never));
  await harness.experimental_dispose();
});

test("down with a retired fence's proof appends --fence-retired <url>", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  await harness.experimental_call("down", { ...leaseTarget, fenceRetired: "https://example.test/proof/1" });
  assert.deepEqual(calls().at(-1)!.argv, ["down", "--context", "test-context-a", "dyntest-a", "--uid", UID, "--lease", "lse_test000001", "--fence-retired", "https://example.test/proof/1"]);
  await assert.rejects(harness.experimental_call("down", { ...leaseTarget, fenceRetired: "--not-a-url" }));
  await harness.experimental_dispose();
});

test("a claimed down passes the fence report through; malformed fence fields are dropped", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  process.env.FAKE_MODE = "claimed_complete";
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), {
    ok: true,
    complete: true,
    resolutions: [],
    fence: { lease_id: "lse_test000001", seq: 7, state: "closing" },
    drain_monotonic_seconds: 120.5,
    max_probe_gap_seconds: 5.5,
    armed: "continuous",
    lease_fence: "true",
  });
  process.env.FAKE_MODE = "claimed_malformed";
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), { ok: true, complete: true, resolutions: [] });
  process.env.FAKE_MODE = "claimed_disarmed";
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), {
    ok: false,
    code: "teardown_incomplete",
    error: "a probe in the drain read disarmed",
    resolutions: [],
    fence_disarmed: true,
    probe: { canary: "disarmed", mode: "absent", scope: "unknown", armed: false, cause: "no fence webhook answered", canary_text: "created (dry run)", mode_text: "created (dry run)" },
  });
  process.env.FAKE_MODE = "claimed_disarmed_bad";
  assert.deepEqual(await harness.experimental_call("down", leaseTarget), { ok: false, code: "teardown_incomplete", error: "a probe in the drain read disarmed" });
  await harness.experimental_dispose();
});
