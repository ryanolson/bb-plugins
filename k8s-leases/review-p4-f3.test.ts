import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

test("profile reads started in the same millisecond cannot restore a superseded permission", async () => {
  const world = await setup();
  await world.tick();
  const allowed = {
    schema_version: 1,
    clusters: {
      [CLUSTER_A]: { context: CLUSTER_A, allowed: "first-choice", bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 },
    },
  };
  world.guard.profiles = allowed;
  const first = world.cluster.create(CLUSTER_A, "review-p4-profile-first", THREAD_A);
  const control = world.cluster.create(CLUSTER_A, "review-p4-profile-control", THREAD_A);
  const handle = world.guard.handle.bind(world.guard);
  let entered!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const response = new Promise<void>((resolve) => { resume = resolve; });
  let pause = true;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "profiles" && pause) {
      pause = false;
      const answer = await handle(method, input, hostId);
      entered();
      await response;
      return answer;
    }
    return handle(method, input, hostId);
  };

  const older = world.acquire(THREAD_A, first, 4);
  await reading;
  try {
    world.guard.profiles = {
      ...allowed,
      clusters: { [CLUSTER_A]: { ...allowed.clusters[CLUSTER_A], allowed: "never" } },
    };
    await world.tick();
    assert.equal((await world.acquire(THREAD_A, control, 4)).json.code, "cluster_never", "the newer read denies the cluster");
  } finally {
    resume();
  }
  const result = await older;
  try {
    assert.equal(result.code, 1, `the older allowed response replaced the newer denial because both reads used timestamp ${world.clock.now()}`);
    assert.equal(result.json.code, "cluster_never");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
