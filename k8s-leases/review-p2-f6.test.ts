import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("down failures after the short wait must accumulate and raise a teardown flag", async (context) => {
  const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p2-slow-failures", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  const failures: Array<() => void> = [];
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "down" && input.leaseId === id) {
      return new Promise((resolve) => {
        failures.push(() => resolve({ ok: false, code: "api_error", error: "namespace deletion failed after 21 seconds" }));
      });
    }
    return handle(method, input, hostId);
  };

  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const run = attempt === 0 ? world.cli(["lease", "release", id], THREAD_A) : world.tick();
      await setImmediate();
      assert.equal(failures.length, attempt + 1);
      context.mock.timers.tick(21_000);
      world.clock.advance(21_000);
      await run;
      failures[attempt]!();
      await setImmediate();
      world.clock.advance(MIN - 21_000);
    }
    assert.equal(ns.deleting, false);
    const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
    assert.ok(flags.some((flag) => flag.kind === "teardown_failing" && flag.lease_id === id), "four failed downs raised no flag because each successful expire cleared their failure count");
  } finally {
    for (const fail of failures) fail();
    context.mock.timers.reset();
  }
});
