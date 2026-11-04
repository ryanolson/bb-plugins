import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, HOST_TWO, HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("a host with broken Kubernetes access cannot prevent a healthy host from expiring a lease", async () => {
  const world = await setup();
  await world.tick();
  const { id, ns, result } = await world.lease(THREAD_A, "review-f1-failover", 4, { hours: 1 });
  assert.equal(result.code, 0);
  world.cluster.setDgd(ns, "worker", 4);
  const handle = world.guard.handle.bind(world.guard);
  const inspectedHosts: string[] = [];
  world.guard.handle = async (method, input, hostId) => {
    if (method === "inspect") {
      inspectedHosts.push(hostId);
      if (hostId === HOST_ONE) {
        return { ok: false, code: "api_error", error: "this host's Kubernetes credentials have expired" };
      }
    }
    return handle(method, input, hostId);
  };

  world.clock.advance(HOUR);
  for (let n = 0; n < 3; n += 1) {
    await world.tick();
    world.clock.advance(MIN);
  }
  assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
  const snapshot = await world.harness.behavior.callRpc("snapshot", null);
  assert.ok(snapshot.hosts.find((host) => host.hostId === HOST_TWO)?.ok, "the second host remains healthy");
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, `DGDs still run after three ticks; inspected hosts: ${inspectedHosts.join(", ")}`);
});
