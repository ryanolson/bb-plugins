// inspect's `allocation` (k8s-guard: per DGD the larger of its spec and its
// live pods, plus GPU pods no DGD owns) can be larger than both totals. The
// plugin must count the largest of the three, at acquire and in the reconcile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

/** DGD a: spec 4, no pods yet. DGD b: spec 0, 4 GPU pods still terminating. Totals 4 and 4; allocation 8. */
function splitAllocation(world: Awaited<ReturnType<typeof setup>>, name: string) {
  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    const result = (await handle(method, input, hostId)) as { ok: boolean; value?: Record<string, unknown> };
    if (method === "inspect" && input.namespace === name && result.ok) {
      return { ok: true, value: { ...result.value, dgd_gpus: 4, pod_gpus: 4, gpu_type: "gb300", gpu_pods_left: 1, allocation: 8, lease_id: null } };
    }
    return result;
  };
}

test("the reconcile counts inspect's allocation: a 4-GPU lease holding 8 is revoked", async () => {
  const world = await setup({ gpuLimits: JSON.stringify({ gb300: 8 }) });
  await world.tick();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-alloc", 4);
  splitAllocation(world, ns.name);
  await world.tick();
  assert.equal((await world.cli(["lease", "show", id])).json.state, "revoking", "an allocation of 8 on a 4-GPU lease was not seen");
  const flags = (await world.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string }>;
  assert.ok(flags.some((f) => f.lease_id === id && f.kind === "over_allocation"));
});

test("acquire counts inspect's allocation: a namespace already holding 8 cannot take a 4-GPU lease", async () => {
  const world = await setup({ gpuLimits: JSON.stringify({ gb300: 8 }) });
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-alloc2", THREAD_A);
  splitAllocation(world, ns.name);
  assert.equal((await world.acquire(THREAD_A, ns, 4)).json.code, "namespace_over_lease");
});
