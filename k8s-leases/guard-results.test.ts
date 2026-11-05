// How the plugin treats each class of guard result (driver's ruling):
// - a host fault (spawn error, timeout, no JSON, kubectl or connection error)
//   fails over to the next host;
// - a refusal never fails over and never cools a host down;
// - pods_left retries down on the next tick, on the same plan;
// - uid_mismatch on a teardown counts as a sighting of a re-created
//   namespace, and never frees GPUs on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, MIN, THREAD_A, setup } from "./test-support.ts";

const HOST_FAULTS = ["guard_missing", "guard_timeout", "guard_output", "guard_error", "kubectl_error", "internal_error"];
const REFUSALS = ["pods_left", "uid_mismatch", "lease_active", "lease_ended", "lease_mismatch", "not_expired", "record_conflict", "not_found"];

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

test("pods_left retries down on the next tick, on the same plan, and is not a failure", async () => {
  const { world, id, downs } = await releasedWith("pods_left");
  for (let n = 0; n < 4; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.deepEqual(downs(), [HOST_ONE, HOST_ONE, HOST_ONE, HOST_ONE, HOST_ONE]);
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
  assert.ok(!flags.some((f) => f.lease_id === id && f.kind === "teardown_failing"), "pods_left within the stuck window raised a flag");
  assert.equal((await world.cli(["lease", "show", id])).json.state, "releasing");
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
  const { world, id } = await releasedWith("pods_left");
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
