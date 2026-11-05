import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, CLUSTER_B, THREAD_A, setup } from "./test-support.ts";

test("two kube contexts for the same namespace UID cannot grant independent leases and teardown authority", async () => {
  const world = await setup();
  try {
    await world.tick();
    const ns = world.cluster.create(CLUSTER_A, "review-p5-context-alias", THREAD_A);
    // Kubeconfig contexts can name the same API server and namespace.
    world.cluster.namespaces.set(world.cluster.key(CLUSTER_B, ns.name), ns);
    const first = await world.acquire(THREAD_A, ns, 2, { clusterName: CLUSTER_A });
    assert.equal(first.code, 0, JSON.stringify(first.json));
    const second = await world.acquire(THREAD_A, ns, 2, { clusterName: CLUSTER_B });
    if (second.code === 0) {
      const shown = await world.cli(["lease", "show", second.json.lease_id]);
      assert.equal(shown.json.uid, ns.uid);
      const slots = await Promise.all([first, second].map((lease) => world.cli(["lease", "op", "begin", lease.json.lease_id], THREAD_A)));
      assert.ok(slots.every((slot) => slot.code === 0), "both leases authorize a write on the same namespace");
      world.cluster.setDgd(ns, "worker", 2);
      assert.equal((await world.cli(["lease", "release", first.json.lease_id], THREAD_A)).code, 0);
      assert.equal((await world.cli(["lease", "show", second.json.lease_id])).json.state, "active");
      assert.equal(ns.deleting, true, "returning one lease deletes the other active lease's namespace with its matching UID");
    }
    assert.equal(second.code, 1, "context aliases granted two slots and let one lease delete the other active lease's namespace");
    assert.equal(second.json.code, "namespace_leased");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
