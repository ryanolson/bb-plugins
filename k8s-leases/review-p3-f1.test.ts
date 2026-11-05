import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("a timed-out inspect must not make expire retry that host and defeat the next tick's failover", { todo: "p3 f1 [timing]: a host's failure is forgotten once its call ends; waits on the redesign" }, async (context) => {
  const world = await setup();
  await world.tick();
  const { ns, result } = await world.lease(THREAD_A, "review-p3-phase-failover", 2);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "a", 2);
  world.cluster.setDgd(ns, "b", 2);
  const handle = world.guard.handle.bind(world.guard);
  let resume!: () => void;
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const started: Array<{ method: string; at: number }> = [];
  world.guard.handle = async (method, input, hostId) => {
    if (hostId === HOST_ONE && input.namespace === ns.name) {
      started.push({ method, at: world.clock.now() });
      if (method === "inspect") {
        await new Promise((resolve) => setTimeout(resolve, 31_000));
        return { ok: false, code: "api_error", error: "this host's cluster access timed out" };
      }
      if (method === "expire") {
        await held;
        return { ok: false, code: "guard_timeout", error: "expire timed out on this host" };
      }
    }
    return handle(method, input, hostId);
  };

  context.mock.timers.enable({ apis: ["setTimeout"] });
  async function advance(ms: number) {
    world.clock.advance(ms);
    context.mock.timers.tick(ms);
    await setImmediate();
  }
  const first = world.tick();
  let second: Promise<void> | undefined;
  try {
    await setImmediate();
    await advance(31_000);
    await advance(MIN - 31_000);
    second = world.tick();
    await setImmediate();
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, `after one minute, the healthy host has received no expire; calls to the broken host: ${JSON.stringify(started)}`);
  } finally {
    await advance(31_000);
    resume();
    await Promise.all([first, second]);
    context.mock.timers.reset();
  }
});
