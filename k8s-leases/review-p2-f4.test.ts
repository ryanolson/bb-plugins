import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("a slow expire on one host must not block the next tick from using a healthy host", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p2-slow-expire", 4, { hours: 1 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  let entered!: () => void;
  let resume!: () => void;
  const expiring = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "expire" && input.leaseId === id && hostId === HOST_ONE) {
      entered();
      await held;
      return { ok: false, code: "guard_timeout", error: "expire timed out on this host" };
    }
    return handle(method, input, hostId);
  };

  world.clock.advance(HOUR);
  const firstTick = world.tick();
  await expiring;
  try {
    assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
    world.clock.advance(MIN);
    await world.tick();
    assert.ok(world.harness.inspection.experimental_hostRpcCalls.some((call) => call.method === "probe" && call.hostId === HOST_TWO));
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "the next tick skipped the lease while expire waited on the first host; the healthy host received no expire");
  } finally {
    resume();
    await firstTick;
  }
});
