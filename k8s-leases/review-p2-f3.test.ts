import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./lib/contract.ts";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

test("an acquire in flight must honor a GPU limit removed before its commit", async () => {
  const world = await setup();
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "review-p2-config-race", THREAD_A);
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === ns.name) {
      entered();
      await held;
    }
    return handle(method, input, hostId);
  };

  const acquiring = world.acquire(THREAD_A, ns, 4);
  await inspecting;
  try {
    await world.harness.behavior.setSettings({ gpuLimits: JSON.stringify({ gb300: 0 }) });
  } finally {
    resume();
  }
  const result = await acquiring;
  const snapshot = await world.harness.behavior.callRpc("snapshot", null) as Snapshot;
  const capacity = snapshot.capacity.find((entry) => entry.gpuType === "gb300")!;
  assert.equal(capacity.limit, 0);
  assert.equal(result.code, 1, `the transaction granted ${capacity.used} GPUs after the configured limit became 0`);
  assert.equal(capacity.used, 0);
});
