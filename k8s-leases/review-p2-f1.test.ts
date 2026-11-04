import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("an unknown GPU type with live GPU pods cannot be charged to another type's budget", async () => {
  const world = await setup();
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "review-p2-unknown-type", THREAD_A);
  world.cluster.setDgd(ns, "worker", 4);
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    const result = await handle(method, input, hostId);
    if (method === "inspect" && input.namespace === ns.name) {
      return { ok: true, value: { ...world.cluster.inspect(ns), gpu_type: null } };
    }
    return result;
  };

  const unknown = await world.acquire(THREAD_A, ns, 4, { gpuType: "h100" });
  const next = await world.lease(THREAD_B, "review-p2-next-type", 4);
  assert.equal(next.result.code, 0);
  await world.guard.apply(next.id, THREAD_B, next.ns, "worker", 4);
  const total = world.cluster.inspect(ns).pod_gpus + world.cluster.inspect(next.ns).pod_gpus;
  assert.ok(unknown.code !== 0, `acquire charged the unknown allocation to h100 and authorized ${total} gb300 GPUs under a limit of 4`);
});
