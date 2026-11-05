import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("concurrent extensions cannot leave an older expires-at after both report synced", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p2-extend-race", 4, { hours: 1 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  await world.tick();

  let entered!: () => void;
  let resume!: () => void;
  const readExpiry = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const handle = world.guard.handle.bind(world.guard);
  let pause = true;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "extend" && input.leaseId === id && pause) {
      pause = false;
      const shown = await world.cli(["lease", "show", id]);
      assert.equal(shown.json.state, "active");
      assert.equal(shown.json.context, input.context);
      assert.equal(shown.json.uid, input.uid);
      entered();
      await held;
      ns.expiresAt = shown.json.expires_at;
      return { ok: true };
    }
    return handle(method, input, hostId);
  };

  const first = world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 });
  await readExpiry;
  const second = world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 60 });
  try {
    await setImmediate();
  } finally {
    resume();
  }
  const results = await Promise.all([first, second]) as Array<{ expiresAt: number; synced: boolean }>;
  assert.ok(results.every((extension) => extension.synced));
  const approvedExpiry = (await world.cli(["lease", "show", id])).json.expires_at;
  assert.equal(Date.parse(approvedExpiry), world.clock.now() + 2.5 * HOUR);
  world.clock.advance(HOUR + 31 * MIN);
  assert.ok(world.clock.now() < Date.parse(approvedExpiry));
  world.guard.bbOffline = true;
  world.guard.offlineTimerRun(HOUR);
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 4, `both extensions reported synced, but expires-at ${ns.expiresAt} stopped work before approved expiry ${approvedExpiry}`);
});
