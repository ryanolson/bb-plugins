// How the plugin treats each class of guard result (driver's ruling):
// - a host fault (spawn error, timeout, no JSON, kubectl or connection error)
//   fails over to the next host;
// - a refusal never fails over and never cools a host down;
// - a down that works started the deletion; GPU pods it leaves are flagged
//   once, and the GPUs stay charged until inspect reports the namespace gone;
// - uid_mismatch on a teardown counts as a sighting of a re-created
//   namespace, and never frees GPUs on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, MIN, THREAD_A, setup } from "./test-support.ts";

const HOST_FAULTS = ["guard_missing", "guard_timeout", "guard_output", "guard_error", "kubectl_error", "internal_error"];
const REFUSALS = ["uid_mismatch", "lease_active", "lease_ended", "lease_mismatch", "not_expired", "record_conflict", "not_found", "lease_record_missing"];

/** A released lease whose down, on host one, answers with `code`. */
async function releasedWith(code: string | "throw") {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "dyntest-results", 1);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "down" && hostId === HOST_ONE) {
      world.guard.calls.push({ hostId, method, cluster: input.context, namespace: input.namespace, uid: input.uid, leaseId: input.leaseId, outcome: `fake:${code}` });
      if (code === "throw") throw new Error("connection reset");
      return { ok: false, code, error: `host one says ${code}` };
    }
    return handle(method, input, hostId);
  };
  await world.cli(["lease", "release", id], THREAD_A);
  const downs = () => world.guard.calls.filter((c) => c.method === "down" && c.leaseId === id).map((c) => c.hostId);
  return { world, id, ns, downs };
}

test("a host fault fails over: down goes on to the next host", async () => {
  for (const code of [...HOST_FAULTS, "throw"]) {
    const { downs, ns } = await releasedWith(code);
    assert.deepEqual(downs(), [HOST_ONE, HOST_TWO], `${code}: down did not fail over`);
    assert.ok(ns.deleting, `${code}: the namespace was not deleted by the next host`);
  }
});

test("a refusal never fails over and never cools the host down", async () => {
  for (const code of REFUSALS) {
    const { world, downs } = await releasedWith(code);
    assert.deepEqual(downs(), [HOST_ONE], `${code}: a refusal failed over to the next host`);
    world.clock.advance(MIN);
    await world.tick();
    assert.deepEqual(downs(), [HOST_ONE, HOST_ONE], `${code}: the next tick did not ask the same host first: the refusal cooled it down`);
  }
});

test("a down that leaves GPU pods: deletion started, one gpu_pods_left flag, and the GPUs charged until inspect says not_found", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-podsleft", 4);
  world.cluster.setDgd(ns, "worker", 4);
  await world.cli(["lease", "release", id], THREAD_A);
  assert.ok(ns.deleting, "down did not start the deletion");
  const charged = async () => ((await world.harness.behavior.callRpc("snapshot", null)) as { capacity: Array<{ gpuType: string; used: number }> }).capacity.find((c) => c.gpuType === "gb300")!.used;
  for (let n = 0; n < 3; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.equal((await world.cli(["lease", "show", id])).json.state, "releasing");
  assert.equal(await charged(), 4, "the GPUs were freed while pods were still terminating");
  // Not done: each tick checks again with another down (the guard sends no second delete).
  assert.ok(world.guard.calls.filter((c) => c.method === "down" && c.leaseId === id).length >= 4, "down was not re-checked on each tick");
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
  assert.equal(flags.filter((f) => f.lease_id === id && f.kind === "gpu_pods_left").length, 1);
  assert.ok(!flags.some((f) => f.lease_id === id && f.kind === "teardown_failing"), "a working down counted as a failure");
  world.cluster.settle();
  await world.tick();
  assert.equal((await world.cli(["lease", "show", id])).json.state, "released");
  assert.equal(await charged(), 0);
});

test("uid_mismatch on a teardown is a sighting of a re-created namespace, and never frees GPUs on its own", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-reborn", 4);
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === ns.name) return { ok: false, code: "kubectl_error", error: "the API is down" };
    if ((method === "expire" || method === "down") && input.namespace === ns.name) return { ok: false, code: "uid_mismatch", error: "it was re-created" };
    return handle(method, input, hostId);
  };
  await world.cli(["lease", "release", id], THREAD_A);
  for (let n = 0; n < 3; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.equal((await world.cli(["lease", "show", id])).json.state, "releasing", "uid_mismatch alone freed the GPUs");
  const shown = (await world.harness.behavior.callRpc("snapshot", null)) as { capacity: Array<{ gpuType: string; used: number }> };
  assert.equal(shown.capacity.find((c) => c.gpuType === "gb300")!.used, 4);
  // The re-creation is on record as a sighting, flagged once for the digest.
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
  assert.equal(flags.filter((f) => f.lease_id === id && f.kind === "namespace_recreated").length, 1);
});

test("a deletion still not done 15 minutes after its first down is flagged, and not before", async () => {
  // down works, but the namespace never goes: its pods never finish terminating.
  const world = await setup();
  await world.tick();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-stuck15", 1);
  world.cluster.setDgd(ns, "worker", 1);
  await world.cli(["lease", "release", id], THREAD_A);
  const flagged = async () =>
    ((await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>).some((f) => f.lease_id === id && f.kind === "teardown_failing");
  for (let n = 0; n < 14; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.equal(await flagged(), false, "flagged before 15 minutes");
  world.clock.advance(MIN);
  await world.tick();
  assert.equal(await flagged(), true, "not flagged at 15 minutes");
});

test("lease_record_missing on extend: no failover, no cool-down, and one digest flag telling the user to release", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-norecord", 1);
  const extends_: string[] = [];
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "extend" && input.namespace === ns.name) {
      extends_.push(hostId);
      return { ok: false, code: "lease_record_missing", error: `${ns.name} has no lease record; \`lease acquire\` writes it` };
    }
    return handle(method, input, hostId);
  };
  const extended = (await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 })) as { synced: boolean };
  assert.equal(extended.synced, false);
  assert.deepEqual(extends_, [HOST_ONE], "lease_record_missing failed over to the next host");
  await world.tick();
  await world.tick();
  assert.deepEqual(extends_, [HOST_ONE, HOST_ONE, HOST_ONE], "the next ticks did not ask the same host first");
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string; detail: string }>;
  const raised = flags.filter((f) => f.lease_id === id && f.kind === "lease_record_missing");
  assert.equal(raised.length, 1);
  assert.match(raised[0]!.detail, /release/);
});
