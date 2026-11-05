import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, MIN, THREAD_A, setup } from "./test-support.ts";

test("a healthy host can delete a returned lease without waiting for another host's expire timeout", async (context) => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p4-down-after-expire", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  let slowStarted!: () => void;
  let healthyExpired!: () => void;
  let resume!: () => void;
  const slow = new Promise<void>((resolve) => { slowStarted = resolve; });
  const healthy = new Promise<void>((resolve) => { healthyExpired = resolve; });
  const response = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "expire" && input.leaseId === id && hostId === HOST_ONE) {
      slowStarted();
      await response;
      return { ok: false, code: "guard_timeout", error: "the first host's expire response timed out" };
    }
    const answer = await handle(method, input, hostId);
    if (method === "expire" && input.leaseId === id && hostId === HOST_TWO) healthyExpired();
    return answer;
  };

  context.mock.timers.enable({ apis: ["setTimeout"] });
  const release = world.cli(["lease", "release", id], THREAD_A);
  let tick: Promise<void> | undefined;
  try {
    await Promise.all([slow, healthy]);
    await setImmediate();
    world.clock.advance(MIN);
    context.mock.timers.tick(MIN);
    await setImmediate();
    assert.equal((await release).code, 0);
    tick = world.tick();
    await setImmediate();
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "the healthy host already completed expire");
    assert.equal(ns.deleting, true, "release and the next tick sent no down because both awaited the unrelated host's expire response");
  } finally {
    resume();
    await Promise.all([release, tick]);
    await setImmediate();
    context.mock.timers.reset();
    await world.harness.lifecycle.dispose();
  }
});
