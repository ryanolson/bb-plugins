import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("an extend that times out can still commit after a newer synced extension and trigger the offline timer early", { todo: "p3 f3 [boundary]: needs k8s-guard's monotonic extend (STRGT-897); proved on the real guard by contract.test.ts, the gate once 897 merges" }, async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p3-extend-timeout", 4, { hours: 1 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  await world.tick();
  const handle = world.guard.handle.bind(world.guard);
  let pause = true;
  let pendingExpiry = "";
  let land!: () => void;
  world.guard.handle = async (method, input, hostId) => {
    if (method === "extend" && input.leaseId === id && hostId === HOST_ONE && pause) {
      pause = false;
      const shown = (await world.cli(["lease", "show", id])).json;
      assert.equal(shown.state, "active");
      assert.equal(shown.context, input.context);
      assert.equal(shown.uid, input.uid);
      pendingExpiry = shown.expires_at;
      // The API request is already sent when the guard reaches its timeout.
      land = () => { ns.expiresAt = pendingExpiry; };
      world.clock.advance(MIN);
      return { ok: false, code: "guard_timeout", error: "extend timed out with its Kubernetes write still in flight" };
    }
    return handle(method, input, hostId);
  };

  const first = await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 }) as { synced: boolean };
  const second = await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 60 }) as { expiresAt: number; synced: boolean };
  assert.equal(first.synced, true, "the other host completes the first extension");
  assert.equal(second.synced, true);
  assert.equal(Date.parse(ns.expiresAt!), second.expiresAt);
  land();
  assert.equal((await world.cli(["lease", "show", id])).json.state, "active");
  world.guard.bbOffline = true;

  world.clock.advance(Date.parse(pendingExpiry) + MIN - world.clock.now());
  assert.ok(world.clock.now() < second.expiresAt);
  world.guard.offlineTimerRun(HOUR);
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 4, "the late API commit restored the older expires-at after both extensions reported synced, so the offline timer stopped an active lease");
});
