// The rules around the "Tests first" cases: each refusal of acquire, the
// slot, renew, thread loss, the CLI's JSON, and the settings audit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { CLUSTER_A, HOUR, MIN, THREAD_A, THREAD_B, UNAPPROVED, setup } from "./test-support.ts";

async function ready(settings: Record<string, string | number> = {}) {
  const world = await setup(settings);
  await world.tick();
  return world;
}

test("acquire refuses a cluster not allowed, a first run not approved, too many hours, an unknown GPU type, and no thread", async () => {
  const world = await ready();
  const stranger = world.cluster.create("test-cluster-unknown", "dyntest-x", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, stranger, 1)).json.code, "cluster_not_allowed");
  const fresh = world.cluster.create(UNAPPROVED, "dyntest-y", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, fresh, 1)).json.code, "first_run_unapproved");
  const ns = world.cluster.create(CLUSTER_A, "dyntest-z", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, ns, 1, { hours: 4.5 })).json.code, "too_many_hours");
  assert.equal((await world.acquire(THREAD_A, ns, 1, { gpuType: "b200" })).json.code, "gpu_type_not_on_cluster");
  const anonymous = await world.cli([
    "lease", "acquire", "--cluster", CLUSTER_A, "--namespace", ns.name, "--uid", ns.uid,
    "--thread", THREAD_A, "--gpu-type", "gb300", "--gpus", "1", "--hours", "1",
  ]);
  assert.equal(anonymous.json.code, "not_your_thread");
  assert.equal((await world.acquire(THREAD_A, ns, 1, { hours: 4 })).code, 0);
});

test("acquire refuses a namespace that already holds more GPUs than asked for", async () => {
  const world = await ready();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-held", THREAD_A);
  world.cluster.setDgd(ns, "stray", 2);
  assert.equal((await world.acquire(THREAD_A, ns, 1)).json.code, "namespace_over_lease");
});

test("every failure prints JSON on stdout with an error and a code, and exits non-zero", async () => {
  const world = await ready();
  const missing = await world.cli(["lease", "show", "lse_nosuchlease1"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.code, "lease_not_found");
  assert.equal(typeof missing.json.error, "string");
});

test("the slot: begin is refused while held, frees at its deadline, and op end with a stale token frees nothing", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-slot", 1);
  const first = await world.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(first.code, 0);
  assert.equal(Date.parse(first.json.deadline), world.clock.now() + 2 * MIN);
  const busy = await world.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(busy.json.code, "slot_busy");
  assert.equal(busy.json.retry_at, first.json.deadline);
  world.clock.advance(2 * MIN);
  const second = await world.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(second.code, 0);
  const stale = await world.cli(["lease", "op", "end", id, first.json.token], THREAD_A);
  assert.equal(stale.code, 0);
  assert.equal(stale.json.state, "active");
  assert.equal(stale.json.lapsed, true);
  assert.equal((await world.cli(["lease", "op", "begin", id], THREAD_A)).json.code, "slot_busy");
  assert.equal((await world.cli(["lease", "op", "end", id, second.json.token], THREAD_A)).json.lapsed, false);
  assert.equal((await world.cli(["lease", "op", "begin", id], THREAD_A)).code, 0);
});

test("the slot belongs to the lease's thread, and only while active and unexpired", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-own", 1, { hours: 1 });
  assert.equal((await world.cli(["lease", "op", "begin", id], THREAD_B)).json.code, "not_your_lease");
  world.clock.advance(HOUR);
  // No tick has run, but the lease reads as revoking at once.
  const late = await world.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(late.json.code, "lease_not_active");
  assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
});

test("renew: once, by the owner, never past the hour limit, and it moves expires-at", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-renew", 1, { hours: 3 });
  assert.equal((await world.cli(["lease", "renew", id], THREAD_B)).json.code, "not_your_lease");
  world.clock.advance(2 * HOUR);
  const renewed = await world.cli(["lease", "renew", id], THREAD_A);
  assert.equal(renewed.code, 0, JSON.stringify(renewed.json));
  // 1 h was left; +3 h would leave 4 h: at the limit, so allowed.
  assert.equal(Date.parse(renewed.json.expires_at), world.clock.now() + 4 * HOUR);
  assert.equal(ns.expiresAt, renewed.json.expires_at);
  assert.equal((await world.cli(["lease", "renew", id], THREAD_A)).json.code, "renewals_used");
});

test("renew never leaves more than the hour limit", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-cap", 1, { hours: 3 });
  const renewed = await world.cli(["lease", "renew", id], THREAD_A);
  assert.equal(Date.parse(renewed.json.expires_at), world.clock.now() + 4 * HOUR);
});

test("a thread lookup that fails for another reason revokes nothing; a deleted or missing thread revokes", async () => {
  const world = await ready();
  const a = await world.lease(THREAD_A, "dyntest-ta", 1);
  const b = await world.lease(THREAD_B, "dyntest-tb", 1);
  world.threads.fates.set(THREAD_A, "error");
  world.threads.fates.set(THREAD_B, "missing");
  await world.tick();
  assert.equal((await world.cli(["lease", "show", a.id])).json.state, "active");
  assert.equal((await world.cli(["lease", "show", b.id])).json.state, "revoking");
  world.threads.fates.set(THREAD_A, "deleted");
  await world.tick();
  assert.equal((await world.cli(["lease", "show", a.id])).json.state, "revoking");
});

test("the thread.archived event revokes at once", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-ev", 1);
  world.threads.fates.set(THREAD_A, "archived");
  await world.harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: THREAD_A, archivedAt: Date.now() } as never) });
  assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
});

test("release: only the owner, and twice is the same as once", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-rel", 1);
  assert.equal((await world.cli(["lease", "release", id], THREAD_B)).json.code, "not_your_lease");
  assert.equal((await world.cli(["lease", "release", id], THREAD_A)).json.state, "releasing");
  assert.equal((await world.cli(["lease", "release", id], THREAD_A)).json.state, "releasing");
});

test("capacity is per GPU type, over every cluster", async () => {
  const world = await ready();
  assert.equal((await world.lease(THREAD_A, "dyntest-g1", 4)).result.code, 0);
  assert.equal((await world.lease(THREAD_A, "dyntest-h1", 8, { gpuType: "h100" })).result.code, 0);
  assert.equal((await world.lease(THREAD_B, "dyntest-g2", 1, { cluster: "test-cluster-b" })).result.json.code, "over_limit");
});

test("a settings change is flagged for the digest; a panel extension is flagged and capped", async () => {
  const world = await ready({ maxExtendHours: 2 });
  await world.harness.behavior.setSettings({ gpuLimits: JSON.stringify({ gb300: 8 }) });
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; detail: string }>;
  assert.ok(flags.some((f) => f.kind === "settings_changed" && /gpuLimits/.test(f.detail)));
  const { id } = await world.lease(THREAD_A, "dyntest-x", 1);
  await assert.rejects(world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 121 }), /2 h/);
  await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 120 });
  const after = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
  assert.ok(after.some((f) => f.kind === "extended" && f.lease_id === id));
});

test("flags clear: a cleared flag leaves the list", async () => {
  const world = await ready();
  await world.harness.behavior.setSettings({ graceMinutes: 30 });
  const [flag] = (await world.cli(["flags", "--json"])).json as Array<{ id: number }>;
  assert.equal((await world.cli(["flag", "clear", String(flag!.id)])).code, 0);
  assert.deepEqual((await world.cli(["flags", "--json"])).json, []);
});

test("bb k8s leases lists live leases, and --all the ended ones too", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-list", 1);
  const live = (await world.cli(["leases", "--json"])).json as Array<{ lease_id: string; namespace: string }>;
  assert.deepEqual(live.map((l) => l.lease_id), [id]);
  await world.cli(["lease", "release", id], THREAD_A);
  world.cluster.settle();
  await world.tick();
  assert.equal(world.cluster.get(ns.cluster, ns.name), undefined);
  assert.deepEqual((await world.cli(["leases", "--json"])).json, []);
  assert.equal(((await world.cli(["leases", "--all", "--json"])).json as unknown[]).length, 1);
  const table = await world.harness.behavior.runCli(["leases", "--all"]);
  assert.match(table.stdout, /dyntest-list/);
});

test("no host configured: acquire fails closed", async () => {
  const world = await ready({ hosts: "[]" });
  const ns = world.cluster.create(CLUSTER_A, "dyntest-nohost", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, ns, 1)).json.code, "enforcement_unhealthy");
});
