import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slow namespace deletion cannot suspend reconciliation of another lease", async () => {
  const world = await setup({ graceMinutes: 0 });
  await world.tick();
  const slow = await world.lease(THREAD_A, "review-f3-slow", 1, { hours: 1 });
  const victim = await world.lease(THREAD_A, "review-f3-victim", 3, { hours: 4 });
  assert.equal(slow.result.code, 0);
  assert.equal(victim.result.code, 0);
  world.cluster.setDgd(victim.ns, "worker", 3);
  await world.tick();

  const downStarted = gate();
  const victimInspected = gate();
  const finishDown = gate();
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "down" && input.leaseId === slow.id) {
      downStarted.resolve();
      await finishDown.promise;
    }
    const result = await handle(method, input, hostId);
    if (method === "inspect" && input.namespace === victim.ns.name) victimInspected.resolve();
    return result;
  };

  world.clock.advance(HOUR);
  const firstTick = world.tick();
  try {
    await Promise.all([downStarted.promise, victimInspected.promise]);
    // A late write lands after the active lease's inspection.
    world.cluster.setDgd(victim.ns, "late", 1);
    assert.equal(world.cluster.inspect(victim.ns).dgd_gpus, 4);
    for (let n = 0; n < 3; n += 1) {
      world.clock.advance(MIN);
      await world.tick();
    }
    assert.equal(world.cluster.inspect(victim.ns).dgd_gpus, 0, "three scheduled ticks must enforce the other lease while down is pending");
  } finally {
    finishDown.resolve();
    await firstTick;
  }
});
