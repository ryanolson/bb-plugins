// One host whose guard calls stall without end. The other host must still
// enforce within one tick: an over-allocation is revoked and scaled to 0.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("a host whose guard calls stall cannot stop the other host from enforcing within one tick", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "dyntest-stall", 2);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  world.cluster.setDgd(ns, "a", 2);
  world.cluster.setDgd(ns, "b", 2); // a late write: 4 GPUs on a lease of 2

  let release!: () => void;
  const stuck = new Promise<void>((resolve) => (release = resolve));
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (hostId === HOST_ONE && method !== "probe" && method !== "profiles") await stuck;
    return handle(method, input, hostId);
  };

  world.clock.advance(MIN);
  const tick = world.tick();
  try {
    await sleep(100);
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "one tick after the over-allocation, with one host stalled, the DGDs still hold GPUs");
    assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
  } finally {
    release();
    await tick;
  }
});
