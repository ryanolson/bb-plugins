// The cluster profiles (schema 1, read on the hosts with `k8s-check --list`)
// decide which clusters a lease may use, their kube context, GPU type and
// GPUs per node. The `clusters` setting applies only when no host can read them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, THREAD_A, setup } from "./test-support.ts";

/** Made-up profiles; the cluster's name differs from its kube context. */
const PROFILES = {
  schema_version: 1,
  bot: { user: "bot-example", kubeconfig: "/home/test/kubeconfig.yaml", developer: "test", namespace_prefix: "dyntest-", admission_namespace: "dyntest-admission" },
  clusters: {
    "lab-a": { context: "proxy.example.test-lab-a", allowed: "first-choice", source: ["test"], bot_can_write: true, gpu_type: "gb300", gpus_per_node: 2 },
    "lab-qa": { context: "proxy.example.test-lab-qa", allowed: "qa-idle", source: ["test"], bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 },
    "lab-ro": { context: "proxy.example.test-lab-ro", allowed: "first-choice", source: ["test"], bot_can_write: false, gpu_type: "gb300", gpus_per_node: 4 },
    "lab-h200": { context: "proxy.example.test-lab-h200", allowed: "first-choice", source: ["test"], bot_can_write: true, gpu_type: "h200", gpus_per_node: 8 },
    "lab-ci": { context: "proxy.example.test-lab-ci", allowed: "never", source: ["test"] },
  },
};

async function withProfiles() {
  const world = await setup({
    firstRunApprovals: JSON.stringify({ "lab-a": "ok", "lab-qa": "ok", "lab-ro": "ok", "lab-h200": "ok", "lab-ci": "ok", [CLUSTER_A]: "ok" }),
  });
  world.guard.profiles = PROFILES;
  await world.tick();
  return world;
}

test("a lease stores the profile name, and every guard call takes the profile's kube context", async () => {
  const world = await withProfiles();
  const ns = world.cluster.create("proxy.example.test-lab-a", "dyntest-prof", THREAD_A);
  const got = await world.acquire(THREAD_A, ns, 2, { clusterName: "lab-a" });
  assert.equal(got.code, 0, JSON.stringify(got.json));
  const shown = (await world.cli(["lease", "show", got.json.lease_id])).json;
  assert.equal(shown.cluster, "lab-a");
  assert.equal(shown.context, "proxy.example.test-lab-a");
  await world.cli(["lease", "release", got.json.lease_id], THREAD_A);
  const calls = world.guard.calls.filter((c) => c.namespace === "dyntest-prof");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.cluster === "proxy.example.test-lab-a"), JSON.stringify(calls));
  assert.ok(calls.some((c) => c.method === "down" && c.outcome === "ok"));
});

test("the profile's GPUs per node decide the one-node rule, over the fallback setting", async () => {
  const world = await withProfiles();
  const ns = world.cluster.create("proxy.example.test-lab-a", "dyntest-node", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, ns, 3, { clusterName: "lab-a" })).json.code, "multi_node_unapproved");
});

test("never, read only, no profile, and a GPU type with no limit: each refused", async () => {
  const world = await withProfiles();
  const make = (context: string, name: string) => world.cluster.create(context, name, THREAD_A);
  assert.equal((await world.acquire(THREAD_A, make("proxy.example.test-lab-ci", "dyntest-ci"), 1, { clusterName: "lab-ci" })).json.code, "cluster_never");
  assert.equal((await world.acquire(THREAD_A, make("proxy.example.test-lab-ro", "dyntest-ro"), 1, { clusterName: "lab-ro" })).json.code, "cluster_read_only");
  // In the fallback setting, but not in the profiles: the profiles win.
  assert.equal((await world.acquire(THREAD_A, make(CLUSTER_A, "dyntest-fb"), 1)).json.code, "cluster_not_allowed");
  const h200 = make("proxy.example.test-lab-h200", "dyntest-h200");
  assert.equal((await world.acquire(THREAD_A, h200, 1, { clusterName: "lab-h200", gpuType: "h200" })).json.code, "gpu_type_no_limit");
  // A type the profile does not name.
  assert.equal((await world.acquire(THREAD_A, make("proxy.example.test-lab-a", "dyntest-b200"), 1, { clusterName: "lab-a", gpuType: "b200" })).json.code, "gpu_type_not_on_cluster");
});

test("a qa-idle cluster is allowed; checking that QA is idle is the runbook's job", async () => {
  const world = await withProfiles();
  const ns = world.cluster.create("proxy.example.test-lab-qa", "dyntest-qa", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, ns, 1, { clusterName: "lab-qa" })).code, 0);
});

test("no host can read the profiles: the fallback clusters setting applies", async () => {
  const world = await setup();
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-fallback", THREAD_A);
  const got = await world.acquire(THREAD_A, ns, 1);
  assert.equal(got.code, 0, JSON.stringify(got.json));
  assert.equal((await world.cli(["lease", "show", got.json.lease_id])).json.context, CLUSTER_A);
});
