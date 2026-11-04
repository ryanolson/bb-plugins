import assert from "node:assert/strict";
import { test } from "node:test";
import { readInspect } from "./lib/guard.ts";
import { CLUSTER_A, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("a malformed inspect UID cannot free capacity while the namespace's GPU pods remain", async () => {
  const world = await setup();
  await world.tick();
  const first = await world.lease(THREAD_A, "review-f7-original", 4);
  assert.equal(first.result.code, 0);
  world.cluster.setDgd(first.ns, "worker", 4);
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === first.ns.name) {
      return readInspect({ ok: true, value: { ...world.cluster.inspect(first.ns), uid: "" } });
    }
    return handle(method, input, hostId);
  };

  await world.tick();
  assert.equal(world.cluster.get(CLUSTER_A, first.ns.name), first.ns, "the original namespace still exists with the same valid UID");
  assert.equal(world.cluster.inspect(first.ns).pod_gpus, 4);
  const next = await world.lease(THREAD_B, "review-f7-next", 4);
  if (next.result.code === 0) {
    assert.ok((await world.guard.apply(next.id, THREAD_B, next.ns, "worker", 4)).began);
  } else {
    assert.equal(next.result.json.code, "over_limit");
  }
  const total = world.cluster.inspect(first.ns).pod_gpus + world.cluster.inspect(next.ns).pod_gpus;
  assert.ok(total <= 4, `the 4-GPU budget now authorizes ${total} live GPUs after an empty UID was mistaken for recreation`);
});
