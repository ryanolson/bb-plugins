import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { MIN, THREAD_A, setup } from "./test-support.ts";

test("a delayed bb thread lookup cannot stop healthy hosts from reconciling an over-allocation", async () => {
  const world = await setup();
  await world.tick();
  const { ns, result } = await world.lease(THREAD_A, "review-p4-thread-lookup", 2);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "a", 2);
  world.cluster.setDgd(ns, "late", 2);

  let resume!: () => void;
  const response = new Promise<void>((resolve) => { resume = resolve; });
  let lookups = 0;
  world.harness.sdk.stub("threads.get", async (input) => {
    lookups += 1;
    await response;
    return world.threads.get(input);
  });
  const ticks: Promise<void>[] = [];
  try {
    for (let n = 0; n < 2; n += 1) {
      world.clock.advance(MIN);
      ticks.push(world.tick());
      await setImmediate();
    }
    assert.equal(lookups, 2, "both scheduled steps started");
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "two ticks and two healthy enforcement hosts performed no allocation inspection while bb's thread request was pending");
  } finally {
    resume();
    await Promise.all(ticks);
    await world.harness.lifecycle.dispose();
  }
});
