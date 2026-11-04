import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("probe and profile maintenance cannot defer enforcement past one minute with a healthy host", async (context) => {
  const world = await setup();
  await world.tick();
  const { ns, result } = await world.lease(THREAD_A, "review-p2-tick-preflight", 2);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "a", 2);
  world.cluster.setDgd(ns, "b", 2);
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (hostId === HOST_ONE && (method === "probe" || method === "profiles")) {
      await new Promise((resolve) => setTimeout(resolve, 34_000));
      throw new Error("host transport failed before its 35-second RPC timeout");
    }
    if (method === "profiles") await new Promise((resolve) => setTimeout(resolve, 19_000));
    return handle(method, input, hostId);
  };

  context.mock.timers.enable({ apis: ["setTimeout"] });
  world.clock.advance(MIN);
  const tick = world.tick();
  try {
    await setImmediate();
    context.mock.timers.tick(34_000);
    world.clock.advance(34_000);
    await setImmediate();
    context.mock.timers.tick(19_000);
    world.clock.advance(19_000);
    await setImmediate();
    context.mock.timers.tick(7_000);
    world.clock.advance(7_000);
    await setImmediate();
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "60 seconds into the tick, a healthy Kubernetes host has received no inspection or expire because profiles are still being refreshed");
  } finally {
    context.mock.timers.tick(60_000);
    await setImmediate();
    await tick;
    context.mock.timers.reset();
  }
});
