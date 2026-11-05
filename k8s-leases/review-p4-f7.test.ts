import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./lib/contract.ts";
import { MIN, THREAD_A, setup } from "./test-support.ts";

test("a namespace stuck deleting with GPU pods raises a teardown flag despite successful delete requests", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p4-stuck-namespace", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  assert.equal((await world.cli(["lease", "release", id], THREAD_A)).json.state, "releasing");
  try {
    // Adjusted by the implementer: the driver raised the stuck threshold from 5 to 15 minutes.
    for (let n = 0; n < 16; n += 1) {
      world.clock.advance(MIN);
      await world.tick();
    }
    assert.equal(ns.deleting, true);
    assert.equal(world.cluster.inspect(ns).pod_gpus, 4);
    const deletions = world.guard.calls.filter((call) => call.method === "down" && call.leaseId === id);
    assert.ok(deletions.length >= 5);
    assert.ok(deletions.every((call) => call.outcome === "ok"));
    const snapshot = await world.harness.behavior.callRpc("snapshot", null) as Snapshot;
    assert.equal(snapshot.capacity.find((row) => row.gpuType === "gb300")!.used, 4);
    assert.equal(snapshot.leases.find((row) => row.id === id)!.state, "releasing");
    assert.ok(snapshot.flags.some((flag) => flag.leaseId === id && flag.kind === "teardown_failing"), "five ticks made no deletion progress, but every successful down reset failures and the digest has no teardown flag");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
