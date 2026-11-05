import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, MIN, THREAD_A, setup } from "./test-support.ts";

test("clearing a namespace recreation flag does not report the same lease's sighting again", async () => {
  const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
  try {
    await world.tick();
    const { id, ns, result } = await world.lease(THREAD_A, "review-p7n-cleared-recreation", 4);
    assert.equal(result.code, 0);
    world.cluster.namespaces.delete(world.cluster.key(ns.cluster, ns.name));
    world.cluster.create(ns.cluster, ns.name, THREAD_A);
    const handle = world.guard.handle.bind(world.guard);
    world.guard.handle = async (method, input, hostId) => {
      if (method === "inspect" && input.namespace === ns.name) {
        return { ok: false, code: "kubectl_error", error: "the allocation lookup failed" };
      }
      return handle(method, input, hostId);
    };

    assert.equal((await world.cli(["lease", "release", id], THREAD_A)).code, 0);
    const recreated = async () => {
      const flags = (await world.cli(["flags", "--json"])).json as Array<{ id: number; kind: string; lease_id: string }>;
      return flags.filter((flag) => flag.lease_id === id && flag.kind === "namespace_recreated");
    };
    const first = await recreated();
    assert.equal(first.length, 1, "control: expire and down share one recreation flag");
    world.clock.advance(MIN);
    await world.tick();
    assert.equal((await recreated()).length, 1, "control: another sighting keeps one open flag");
    assert.equal((await world.cli(["flag", "clear", String(first[0]!.id)])).code, 0);
    assert.equal((await recreated()).length, 0);

    world.clock.advance(MIN);
    await world.tick();
    assert.equal((await world.cli(["lease", "show", id])).json.state, "releasing");
    assert.equal((await recreated()).length, 0, "the digest already reported this lease's re-created namespace");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
