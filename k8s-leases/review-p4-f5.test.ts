import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, MIN, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("an older inspect merge cannot free GPUs after a newer answer still sees their namespace", async () => {
  const world = await setup();
  await world.tick();
  const first = await world.lease(THREAD_A, "review-p4-stale-merge", 4);
  assert.equal(first.result.code, 0);
  world.cluster.setDgd(first.ns, "worker", 4);

  let slowStarted!: () => void;
  let seenAgain!: () => void;
  let resume!: () => void;
  const slow = new Promise<void>((resolve) => { slowStarted = resolve; });
  const newerSeen = new Promise<void>((resolve) => { seenAgain = resolve; });
  const response = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  let firstHostReads = 0;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === first.ns.name) {
      if (hostId === HOST_ONE) {
        firstHostReads += 1;
        if (firstHostReads === 1) return { ok: false, code: "not_found", error: "this host temporarily routed to the wrong cluster" };
        const answer = await handle(method, input, hostId);
        seenAgain();
        return answer;
      }
      if (hostId === HOST_TWO) {
        slowStarted();
        await response;
        return { ok: false, code: "guard_timeout", error: "the second host could not inspect the namespace" };
      }
    }
    return handle(method, input, hostId);
  };

  const older = world.tick();
  await slow;
  await setImmediate();
  world.clock.advance(MIN);
  const newer = world.tick();
  try {
    await newerSeen;
    await setImmediate();
    assert.equal((await world.cli(["lease", "show", first.id])).json.state, "active");
  } finally {
    resume();
    await Promise.all([older, newer]);
  }

  try {
    assert.equal(world.cluster.inspect(first.ns).pod_gpus, 4, "the original namespace still holds all four GPUs");
    const next = await world.lease(THREAD_B, "review-p4-stale-merge-next", 4);
    if (next.result.code === 0) await world.guard.apply(next.id, THREAD_B, next.ns, "worker", 4);
    const total = world.cluster.inspect(first.ns).pod_gpus + world.cluster.inspect(next.ns).pod_gpus;
    assert.ok(total <= 4, `the older step discarded the newer same-UID observation and authorized ${total} live GPUs under a budget of 4`);
    assert.equal(next.result.json.code, "over_limit");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
