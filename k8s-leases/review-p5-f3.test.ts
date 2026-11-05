import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("an inherited object property cannot supply an absent GPU limit", async () => {
  const world = await setup({
    clusters: JSON.stringify({ [CLUSTER_A]: { gpusPerNode: { constructor: 4, h200: 4 } } }),
  });
  try {
    await world.tick();
    const control = await world.lease(THREAD_A, "review-p5-no-limit-control", 1, { gpuType: "h200" });
    assert.equal(control.result.code, 1);
    assert.equal(control.result.json.code, "gpu_type_no_limit", "a GPU type without a limit must fail closed");
    const first = await world.lease(THREAD_A, "review-p5-no-limit-first", 4, { gpuType: "constructor" });
    const second = await world.lease(THREAD_B, "review-p5-no-limit-second", 4, { gpuType: "constructor" });
    assert.equal(first.result.code, 1, `an absent limit authorized ${[first, second].filter((lease) => lease.result.code === 0).length * 4} GPUs`);
    assert.equal(first.result.json.code, "gpu_type_no_limit");
    assert.equal(second.result.code, 1);
  } finally {
    await world.harness.lifecycle.dispose();
  }
});

test("an inherited object property cannot supply an absent first-run approval", async () => {
  const world = await setup({
    clusters: JSON.stringify({ constructor: { gpusPerNode: { gb300: 4 } }, [CLUSTER_A]: { gpusPerNode: { gb300: 4 } } }),
    firstRunApprovals: "{}",
  });
  try {
    await world.tick();
    const control = await world.lease(THREAD_A, "review-p5-no-approval-control", 1);
    assert.equal(control.result.json.code, "first_run_unapproved");
    const actual = await world.lease(THREAD_A, "review-p5-no-approval", 4, { cluster: "constructor" });
    assert.equal(actual.result.code, 1, "the cluster has no first-run approval but inherited Object.constructor was accepted");
    assert.equal(actual.result.json.code, "first_run_unapproved");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
