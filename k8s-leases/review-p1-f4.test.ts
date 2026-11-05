import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_A, setup } from "./test-support.ts";

test("release during an active tick still runs down before the release and tick finish", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-f4-race", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  await world.tick();

  let inspected!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { inspected = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  let pause = true;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === ns.name && pause) {
      pause = false;
      inspected();
      await held;
    }
    return handle(method, input, hostId);
  };

  const tick = world.tick();
  await entered;
  const release = world.cli(["lease", "release", id], THREAD_A);
  try {
    const shown = await world.cli(["lease", "show", id]);
    assert.ok(["releasing", "released"].includes(shown.json.state), "the return commits while the tick's inspection is pending");
  } finally {
    resume();
    await Promise.all([tick, release]);
  }
  assert.equal(ns.deleting, true, "neither the immediate release nor the in-flight tick called down");
});
