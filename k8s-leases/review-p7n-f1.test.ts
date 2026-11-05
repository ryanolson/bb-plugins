import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_TWO, HOUR, THREAD_A, setup } from "./test-support.ts";

async function recreationFlags(secondHostFault: boolean): Promise<number> {
  const world = await setup();
  try {
    await world.tick();
    const { id, ns, result } = await world.lease(THREAD_A, "review-p7n-partial-recreation", 4, { hours: 1 });
    assert.equal(result.code, 0);
    world.cluster.namespaces.delete(world.cluster.key(ns.cluster, ns.name));
    const replacement = world.cluster.create(ns.cluster, ns.name, THREAD_A);
    world.cluster.setDgd(replacement, "worker", 4);

    const handle = world.guard.handle.bind(world.guard);
    world.guard.handle = async (method, input, hostId) => {
      if (input.namespace === ns.name) {
        if (method === "inspect" || (method === "expire" && hostId === HOST_TWO && secondHostFault)) {
          return { ok: false, code: "kubectl_error", error: "the host cannot reach the API" };
        }
      }
      return handle(method, input, hostId);
    };

    world.clock.advance(HOUR);
    await world.tick();
    assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking");
    assert.ok(world.guard.calls.some((call) => call.method === "expire" && call.leaseId === id && call.outcome === "refused:uid_mismatch"));
    assert.ok(!world.guard.calls.some((call) => call.method === "down" && call.leaseId === id), "the deletion grace must keep down from recording the sighting");
    assert.equal(replacement.deleting, false);
    const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
    return flags.filter((flag) => flag.lease_id === id && flag.kind === "namespace_recreated").length;
  } finally {
    await world.harness.lifecycle.dispose();
  }
}

test("an expire UID mismatch is flagged even when another host faults during grace", async () => {
  assert.equal(await recreationFlags(false), 1, "control: both hosts report the replacement");
  assert.equal(await recreationFlags(true), 1, "a host fault must not hide the other host's UID mismatch");
});
