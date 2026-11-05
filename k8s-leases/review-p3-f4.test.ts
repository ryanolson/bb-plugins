import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("a failed allocation inspection cannot prevent a returned lease's UID-fenced teardown", { todo: 'p3 f4 [structure]: teardown waits on inspect; waits on the redesign' }, async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-p3-inspect-release", 4);
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect" && input.namespace === ns.name) {
      return { ok: false, code: "api_error", error: "the allocation inspection failed to list GPU pods" };
    }
    return handle(method, input, hostId);
  };

  const released = await world.cli(["lease", "release", id], THREAD_A);
  assert.equal(released.code, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.equal((await world.cli(["lease", "show", id])).json.state, "releasing");
  const replicas = world.cluster.inspect(ns).dgd_gpus;
  const writes = world.guard.writes().filter((call) => call.leaseId === id);
  const control = await world.guard.handle("down", { context: ns.cluster, namespace: ns.name, uid: ns.uid, leaseId: id }, HOST_ONE);
  assert.deepEqual(control, { ok: true });
  assert.equal(ns.deleting, true);
  assert.ok(writes.some((call) => call.method === "down" && call.outcome === "ok"), `release and three retries never dispatched down, although its UID-fenced guard path works; GPU replicas left: ${replicas}`);
});
