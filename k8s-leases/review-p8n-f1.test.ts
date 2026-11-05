import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./lib/contract.ts";
import { HOST_ONE, HOST_TWO, HOUR, THREAD_A, setup } from "./test-support.ts";

test("an expire UID mismatch is flagged when another host successfully scaled the previous namespace", async () => {
  const world = await setup();
  try {
    await world.tick();
    const { id, ns, result } = await world.lease(THREAD_A, "review-p8n-mixed-recreation", 4, { hours: 1 });
    assert.equal(result.code, 0);
    world.cluster.setDgd(ns, "worker", 4);

    let replaced!: () => void;
    const replacementReady = new Promise<void>((resolve) => { replaced = resolve; });
    const handle = world.guard.handle.bind(world.guard);
    world.guard.handle = async (method, input, hostId) => {
      if (input.namespace !== ns.name) return handle(method, input, hostId);
      if (method === "inspect") return { ok: false, code: "kubectl_error", error: "the allocation lookup failed" };
      if (method === "expire" && hostId === HOST_ONE) {
        const answer = await handle(method, input, hostId);
        world.cluster.namespaces.delete(world.cluster.key(ns.cluster, ns.name));
        const replacement = world.cluster.create(ns.cluster, ns.name, THREAD_A);
        world.cluster.setDgd(replacement, "worker", 4);
        replaced();
        return answer;
      }
      if (method === "expire" && hostId === HOST_TWO) await replacementReady;
      return handle(method, input, hostId);
    };

    world.clock.advance(HOUR);
    await world.tick();

    const expires = world.guard.calls.filter((call) => call.method === "expire" && call.leaseId === id);
    assert.ok(expires.some((call) => call.hostId === HOST_ONE && call.outcome === "ok"));
    assert.ok(expires.some((call) => call.hostId === HOST_TWO && call.outcome === "refused:uid_mismatch"));
    assert.ok(!world.guard.calls.some((call) => call.method === "down" && call.leaseId === id));
    const snapshot = await world.harness.behavior.callRpc("snapshot", null) as Snapshot;
    assert.equal(snapshot.leases.find((lease) => lease.id === id)!.state, "revoking");
    assert.equal(snapshot.capacity.find((row) => row.gpuType === "gb300")!.used, 4);
    assert.equal(world.cluster.get(ns.cluster, ns.name)!.deleting, false);
    assert.equal(snapshot.flags.filter((flag) => flag.leaseId === id && flag.kind === "namespace_recreated").length, 1, "a successful expire must not hide another host's UID mismatch");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
