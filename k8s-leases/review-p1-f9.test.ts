import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR, THREAD_A, setup } from "./test-support.ts";

test("the owner can return a revoking lease without waiting for the rest of its deletion grace", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-f9-return", 4, { hours: 1 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  world.clock.advance(HOUR);
  await world.tick();
  assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
  assert.equal(ns.deleting, false, "the expiry's deletion grace has just started");

  const returned = await world.cli(["lease", "release", id], THREAD_A);
  assert.equal(returned.code, 0);
  assert.equal(ns.deleting, true, `release returned ${JSON.stringify(returned.json)} without running down at once`);
});
