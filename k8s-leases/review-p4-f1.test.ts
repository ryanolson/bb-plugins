import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("a pending expire response cannot replace the next tick's scale-to-zero after a late write", async () => {
  const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p4-shared-expire", 4, { hours: 1 });
  assert.equal(result.code, 0);
  const paused = await world.guard.apply(id, THREAD_A, ns, "late", 4, { pause: true });
  assert.equal(paused.began, true);

  let scaled!: () => void;
  let resume!: () => void;
  const expired = new Promise<void>((resolve) => { scaled = resolve; });
  const response = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  let expireCalls = 0;
  world.guard.handle = async (method, input, hostId) => {
    const answer = await handle(method, input, hostId);
    if (method === "expire" && input.leaseId === id) {
      expireCalls += 1;
      if (expireCalls === 1) {
        scaled();
        await response;
      }
    }
    return answer;
  };

  world.clock.advance(HOUR);
  const first = world.tick();
  let second: Promise<void> | undefined;
  try {
    await expired;
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0);
    await paused.land();
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 4);
    const inspections = world.guard.calls.filter((call) => call.method === "inspect").length;
    world.clock.advance(MIN);
    second = world.tick();
    await setImmediate();
    assert.ok(world.guard.calls.filter((call) => call.method === "inspect").length > inspections, "the next tick reached this lease");
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, `a healthy host executed only ${expireCalls} expire call(s); the next tick reused an effect that preceded the late write`);
  } finally {
    resume();
    await Promise.all([first, second]);
    await world.harness.lifecycle.dispose();
  }
});
