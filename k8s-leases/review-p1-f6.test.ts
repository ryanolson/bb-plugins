import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("agent renewal cannot shorten a panel extension and make the offline timer stop work early", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-f6-renew", 4, { hours: 2 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  const extended = (await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 360 })) as { expiresAt: number; synced: boolean };
  assert.equal(extended.synced, true);
  assert.equal(extended.expiresAt, world.clock.now() + 8 * HOUR);
  assert.equal(Date.parse(ns.expiresAt!), extended.expiresAt);

  const renewed = await world.cli(["lease", "renew", id], THREAD_A);
  world.clock.advance(4 * HOUR + MIN);
  assert.ok(world.clock.now() < extended.expiresAt, "the approved extension still has almost four hours left");
  world.guard.bbOffline = true;
  world.guard.offlineTimerRun(HOUR);
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 4, `renew returned ${JSON.stringify(renewed)} and moved expires-at to ${ns.expiresAt}`);
});
