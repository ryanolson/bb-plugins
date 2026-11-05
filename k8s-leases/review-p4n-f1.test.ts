import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("a later live observation fences a missing snapshot even when the live call started first", async () => {
  const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
  await world.tick();
  const first = await world.lease(THREAD_A, "review-p4n-observation-order", 4);
  assert.equal(first.result.code, 0);
  world.cluster.setDgd(first.ns, "worker", 4);

  let startedLive!: () => void;
  let startRead!: () => void;
  let readMissing!: () => void;
  let returnMissing!: () => void;
  const liveStarted = new Promise<void>((resolve) => { startedLive = resolve; });
  const liveGate = new Promise<void>((resolve) => { startRead = resolve; });
  const missingRead = new Promise<void>((resolve) => { readMissing = resolve; });
  const missingGate = new Promise<void>((resolve) => { returnMissing = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  const observations: string[] = [];
  let inspections = 0;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === first.ns.name) {
      inspections += 1;
      if (inspections === 1) {
        startedLive();
        await liveGate;
        const answer = await handle(method, input, hostId);
        observations.push("live");
        return answer;
      }
      const answer = { ok: false, code: "not_found", error: "this request reached the wrong cluster" };
      observations.push("missing");
      readMissing();
      await missingGate;
      return answer;
    }
    return handle(method, input, hostId);
  };

  const older = world.tick();
  let newer: Promise<void> | undefined;
  try {
    await liveStarted;
    newer = world.tick();
    await missingRead;
    startRead();
    await older;
    assert.deepEqual(observations, ["missing", "live"], "the live namespace was read after the missing snapshot");
    assert.equal((await world.cli(["lease", "show", first.id])).json.state, "active");
    returnMissing();
    await newer;

    const next = await world.lease(THREAD_B, "review-p4n-observation-next", 4);
    if (next.result.code === 0) await world.guard.apply(next.id, THREAD_B, next.ns, "worker", 4);
    const total = world.cluster.inspect(first.ns).pod_gpus + world.cluster.inspect(next.ns).pod_gpus;
    assert.ok(total <= 4, `call-start order discarded a later live observation and authorized ${total} live GPUs under a budget of 4`);
    assert.equal(next.result.json.code, "over_limit");
  } finally {
    startRead();
    returnMissing();
    await Promise.all([older, newer]);
    await world.harness.lifecycle.dispose();
  }
});
