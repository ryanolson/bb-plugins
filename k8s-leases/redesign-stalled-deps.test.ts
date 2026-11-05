// Every dependency other than the guard stalls at once: the thread lookup,
// the profile read and the probes. Within one tick, a lease that is already
// not active still gets expire on a healthy host, and an active lease holding
// more GPUs than leased is still inspected, revoked and scaled to 0.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("with the thread lookup, the profile read and every probe stalled, expire still reaches a healthy host within one tick", async () => {
  const world = await setup({ gpuLimits: JSON.stringify({ gb300: 8 }) });
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "dyntest-deps", 4, { hours: 1 });
  assert.equal(result.code, 0, JSON.stringify(result.json));
  world.cluster.setDgd(ns, "worker", 4);
  const over = await world.lease(THREAD_A, "dyntest-deps-over", 2, { cluster: "test-cluster-b", hours: 4 });
  assert.equal(over.result.code, 0, JSON.stringify(over.result.json));
  world.cluster.setDgd(over.ns, "a", 2);
  world.cluster.setDgd(over.ns, "b", 2);

  let release!: () => void;
  const stuck = new Promise<void>((resolve) => (release = resolve));
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "probe" || method === "profiles") await stuck;
    return handle(method, input, hostId);
  };
  const lookup = world.threads.get;
  world.threads.get = async (args) => {
    await stuck;
    return lookup(args);
  };
  world.harness.sdk.stub("threads.get", world.threads.get as never);

  world.clock.advance(HOUR + MIN);
  const tick = world.tick();
  try {
    await sleep(100);
    assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "an expired lease still holds GPUs while the thread lookup, profile read and probes stall");
    assert.equal((await world.cli(["lease", "show", over.id])).json.state, "revoking");
    assert.equal(world.cluster.inspect(over.ns).dgd_gpus, 0, "an over-allocated active lease was not enforced while the thread lookup stalled");
  } finally {
    release();
    await tick;
  }
});
