import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, CLUSTER_B, THREAD_A, setup } from "./test-support.ts";

test("two profile names for one context cannot grant two leases and slots on the same namespace", async () => {
  const world = await setup();
  const profile = { context: CLUSTER_A, allowed: "first-choice", bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 };
  world.guard.profiles = { schema_version: 1, clusters: { [CLUSTER_A]: profile, [CLUSTER_B]: profile } };
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "review-p2-alias", THREAD_A);
  const first = await world.acquire(THREAD_A, ns, 2, { clusterName: CLUSTER_A });
  assert.equal(first.code, 0, JSON.stringify(first.json));

  const second = await world.acquire(THREAD_A, ns, 2, { clusterName: CLUSTER_B });
  if (second.code === 0) {
    const slots = await Promise.all([first, second].map((lease) => world.cli(["lease", "op", "begin", lease.json.lease_id], THREAD_A)));
    assert.equal(slots.filter((slot) => slot.code === 0).length, 1, "one namespace now has two active leases and two independent write slots");
  }
  assert.equal(second.code, 1, "namespace exclusivity must use the Kubernetes target, not its profile alias");
  assert.equal(second.json.code, "namespace_leased");
});
