import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN, THREAD_A, setup } from "./test-support.ts";

test("a failed down still scales a releasing lease's DGDs to zero on each tick", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-f2-release", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  world.guard.failDown = true;

  const returned = await world.cli(["lease", "release", id], THREAD_A);
  assert.equal(returned.code, 0);
  assert.equal(returned.json.state, "releasing");
  for (let n = 0; n < 3; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  const flags = (await world.cli(["flags", "--json"])).json;
  assert.ok(flags.some((flag: { kind: string; lease_id: string }) => flag.kind === "teardown_failing" && flag.lease_id === id));
  assert.ok(world.guard.calls.some((call) => call.method === "down" && call.leaseId === id && call.outcome === "failed"));
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "a deletion failure must not leave a non-active lease's DGDs at 4 GPUs");
});
