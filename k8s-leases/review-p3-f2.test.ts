import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

test("a delayed profile reply cannot overwrite a newer denial and authorize another lease", async () => {
  const world = await setup();
  await world.tick();
  const allowed = {
    schema_version: 1,
    clusters: {
      [CLUSTER_A]: { context: CLUSTER_A, allowed: "first-choice", bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 },
    },
  };
  world.guard.profiles = allowed;
  const ns = world.cluster.create(CLUSTER_A, "review-p3-stale-profiles", THREAD_A);
  const control = world.cluster.create(CLUSTER_A, "review-p3-denied-profiles", THREAD_A);
  const handle = world.guard.handle.bind(world.guard);
  let entered!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  let pause = true;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "profiles" && pause) {
      pause = false;
      const snapshot = await handle(method, input, hostId);
      entered();
      await held;
      return snapshot;
    }
    return handle(method, input, hostId);
  };

  const older = world.acquire(THREAD_A, ns, 4);
  await reading;
  try {
    world.guard.profiles = {
      ...allowed,
      clusters: { [CLUSTER_A]: { ...allowed.clusters[CLUSTER_A], allowed: "never" } },
    };
    world.clock.advance(1_000);
    await world.tick();
    assert.equal((await world.acquire(THREAD_A, control, 4)).json.code, "cluster_never");
  } finally {
    resume();
    await older;
  }

  const acquired = await older;
  assert.equal(acquired.code, 1, "a late reply replaced the newer never profile with an allowed profile and stamped it with the current time");
  assert.equal(acquired.json.code, "cluster_never");
});
