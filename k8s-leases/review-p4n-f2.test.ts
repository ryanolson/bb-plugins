import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./lib/contract.ts";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("successful teardown requests cannot hide failed inspections of a stuck deletion", async () => {
  const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p4n-stuck-unreadable", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  const handle = world.guard.handle.bind(world.guard);
  let inspectionFailures = 0;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === ns.name) {
      inspectionFailures += 1;
      return { ok: false, code: "api_error", error: "listing GPU pods is forbidden" };
    }
    return handle(method, input, hostId);
  };

  try {
    assert.equal((await world.cli(["lease", "release", id], THREAD_A)).code, 0);
    // Adjusted by the implementer: the driver raised the stuck threshold from 5 to 15 minutes.
    for (let n = 0; n < 16; n += 1) {
      world.clock.advance(MIN);
      await world.tick();
    }

    assert.equal(inspectionFailures, 17);
    assert.equal(ns.deleting, true);
    assert.equal(world.cluster.inspect(ns).pod_gpus, 4);
    const deletions = world.guard.calls.filter((call) => call.method === "down" && call.leaseId === id);
    assert.equal(deletions.length, 17);
    assert.ok(deletions.every((call) => call.outcome === "ok"));
    const snapshot = await world.harness.behavior.callRpc("snapshot", null) as Snapshot;
    assert.equal(snapshot.capacity.find((row) => row.gpuType === "gb300")!.used, 4);
    assert.equal(snapshot.leases.find((row) => row.id === id)!.state, "releasing");
    assert.ok(snapshot.flags.some((flag) => flag.leaseId === id && flag.kind === "teardown_failing"), "seven failed inspections and six minutes of stuck deletion raised no flag because successful teardown requests cleared each inspection failure");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
