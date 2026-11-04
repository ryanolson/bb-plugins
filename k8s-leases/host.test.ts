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
if (process.argv[2] === "inspect") {
  process.stdout.write(JSON.stringify({ uid: ${JSON.stringify(UID)}, thread: "thr_aaaa1111", expires_at: "2026-11-05T12:00:00Z", dgd_gpus: 4, pod_gpus: 2, gpu_type: "gb300", gpu_pods_left: 1, extra: true }));
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

const target = { run: RUN, cluster: "test-cluster-a", namespace: "dyntest-a" };
const leaseTarget = { ...target, uid: UID, leaseId: "lse_test000001" };

test("inspect runs the guard with an explicit --context, and the bb server URL and kubeconfig", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  const result = await harness.experimental_call("inspect", target);
  assert.deepEqual(result, {
    ok: true,
    value: { uid: UID, thread: "thr_aaaa1111", expires_at: "2026-11-05T12:00:00Z", dgd_gpus: 4, pod_gpus: 2, gpu_type: "gb300", gpu_pods_left: 1 },
  });
  assert.deepEqual(calls(), [{ name: "k8s-guard", argv: ["inspect", "--context", "test-cluster-a", "dyntest-a"], server: RUN.serverUrl, kubeconfig: RUN.kubeconfig }]);
  await harness.experimental_dispose();
});

test("expire, down and extend pass the namespace UID and the lease", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry());
  for (const method of ["expire", "down", "extend"] as const) {
    assert.deepEqual(await harness.experimental_call(method, leaseTarget), { ok: true });
  }
  assert.deepEqual(
    calls().map((c) => c.argv),
    ["expire", "down", "extend"].map((m) => [m, "--context", "test-cluster-a", "dyntest-a", "--uid", UID, "--lease", "lse_test000001"]),
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
  await assert.rejects(harness.experimental_call("inspect", { ...target, cluster: "-A" }));
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
