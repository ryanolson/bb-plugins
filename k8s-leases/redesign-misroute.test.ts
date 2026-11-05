// One host that misroutes: it answers for another namespace, or for a
// cluster where the namespace does not exist. Its answer must never free a
// lease's GPUs while another host still sees the namespace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_B, HOST_ONE, THREAD_A, THREAD_B, newUid, setup } from "./test-support.ts";

test("a host that answers for the wrong namespace or cluster cannot free a lease's GPUs", async () => {
  const world = await setup();
  await world.tick();
  const wrongNs = await world.lease(THREAD_A, "dyntest-misroute-ns", 2);
  const wrongCluster = await world.lease(THREAD_A, "dyntest-misroute-cl", 2);
  assert.equal(wrongNs.result.code, 0, JSON.stringify(wrongNs.result.json));
  assert.equal(wrongCluster.result.code, 0, JSON.stringify(wrongCluster.result.json));
  world.cluster.setDgd(wrongNs.ns, "worker", 2);
  world.cluster.setDgd(wrongCluster.ns, "worker", 2);

  const handle = world.guard.handle.bind(world.guard);
  world.guard.handle = async (method, input, hostId) => {
    if (hostId === HOST_ONE && method === "inspect" && input.namespace === wrongNs.ns.name) {
      // Another namespace's view: a different UID and no GPUs.
      return { ok: true, value: { uid: newUid(), thread: THREAD_B, expires_at: null, dgd_gpus: 0, pod_gpus: 0, gpu_type: null, gpu_pods_left: 0 } };
    }
    if (hostId === HOST_ONE && method === "inspect" && input.namespace === wrongCluster.ns.name) {
      return { ok: false, code: "not_found", error: "namespace not found (wrong cluster)" };
    }
    return handle(method, input, hostId);
  };

  for (let n = 0; n < 3; n += 1) await world.tick();
  for (const { id } of [wrongNs, wrongCluster]) {
    assert.equal((await world.cli(["lease", "show", id])).json.state, "active", `lease ${id} was ended on one misrouted host's word`);
  }
  // The 4 gb300 GPUs stay charged.
  const other = world.cluster.create(CLUSTER_B, "dyntest-misroute-next", THREAD_B);
  assert.equal((await world.acquire(THREAD_B, other, 1)).json.code, "over_limit");
});
