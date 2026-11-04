import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

test("a multi-node approval authorizes one lease, not every later lease of a recreated namespace", async () => {
  const name = "review-f5-approval";
  const world = await setup({
    gpuLimits: JSON.stringify({ gb300: 16 }),
    multiNodeApprovals: JSON.stringify([{ cluster: CLUSTER_A, namespace: name, thread: THREAD_A, maxGpus: 8, record: "approval for the first lease" }]),
  });
  await world.tick();
  const first = await world.lease(THREAD_A, name, 8);
  assert.equal(first.result.code, 0);
  assert.equal((await world.cli(["lease", "show", first.id])).json.multi_node, true);
  assert.equal((await world.cli(["lease", "release", first.id], THREAD_A)).code, 0);
  world.cluster.settle();
  await world.tick();
  assert.equal((await world.cli(["lease", "show", first.id])).json.state, "released");

  const next = world.cluster.create(CLUSTER_A, name, THREAD_A);
  assert.notEqual(next.uid, first.ns.uid);
  const unapproved = await world.acquire(THREAD_A, next, 8);
  assert.equal(unapproved.code, 1, "the first lease's approval must not authorize another lease with a new UID");
  assert.equal(unapproved.json.code, "multi_node_unapproved");
});
