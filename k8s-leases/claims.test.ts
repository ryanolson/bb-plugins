// Claims of the pre-made namespace (phase 1): the plugin's SQLite row is the
// claim, the charge and the completion. The owner comes from the calling
// thread; a host checks the exact profile name, both Namespace labels and the
// live UID; reclaim is adopt-or-replace; a write's attempt is recorded before
// it is sent; and a claimed lease frees its GPUs only through one conditional
// completion, never because its namespace looks gone. Claims stay off until
// the admission webhook exists: the production default refuses them.
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Config } from "./lib/settings.ts";
import { MIGRATIONS, createStore } from "./lib/store.ts";
import { CLUSTER_A, DEVELOPER, HOST_ONE, HOUR, MIN, PREMADE, T0, THREAD_A, THREAD_B, setup, ticksUntil, type SetupOptions } from "./test-support.ts";

const PROFILES = {
  schema_version: 1,
  bot: { user: "bot-example", kubeconfig: "/home/test/kubeconfig.yaml", developer: DEVELOPER, namespace_prefix: "dyntest-alice-", premade_namespace: PREMADE },
  clusters: {
    [CLUSTER_A]: { context: CLUSTER_A, allowed: "first-choice", source: ["test"], bot_can_write: true, gpu_type: "gb300", gpus_per_node: 4 },
  },
};

async function world(options: SetupOptions = { admission: () => true }) {
  const w = await setup({}, options);
  w.guard.profiles = PROFILES;
  await w.tick(); // heartbeats and the profile read
  const ns = w.cluster.premade(CLUSTER_A);
  return Object.assign(w, { ns });
}

type World = Awaited<ReturnType<typeof world>>;

async function show(w: World, id: string) {
  const shown = await w.cli(["lease", "show", id]);
  assert.equal(shown.code, 0, JSON.stringify(shown.json));
  return shown.json;
}

async function used(w: World): Promise<number> {
  const live = (await w.cli(["leases", "--json"])).json as Array<{ gpus: number }>;
  return live.reduce((sum, row) => sum + row.gpus, 0);
}

test("claims stay off by default: without the admission webhook acquire refuses enforcement_unhealthy", async () => {
  const w = await world({});
  const got = await w.claim(THREAD_A, w.ns, 2);
  assert.equal(got.code, 1, JSON.stringify(got.json));
  assert.equal(got.json.code, "enforcement_unhealthy");
  assert.match(got.json.error, /admission/);
  assert.equal(await used(w), 0);
});

test("a claim takes the owner from the calling thread, never from --thread", async () => {
  const w = await world();
  const posing = await w.claim(THREAD_A, w.ns, 2, { thread: THREAD_B });
  assert.equal(posing.code, 1);
  assert.equal(posing.json.code, "not_your_thread");
  const got = await w.claim(THREAD_A, w.ns, 2);
  assert.equal(got.code, 0, JSON.stringify(got.json));
  const lease = await show(w, got.json.lease_id);
  assert.equal(lease.thread, THREAD_A);
  assert.equal(lease.mode, "claimed");
  assert.equal(lease.uid, w.ns.uid);
});

test("a host checks the exact profile name, both Namespace labels and the live UID", async () => {
  const w = await world();
  const other = w.cluster.premade(CLUSTER_A, "dyntest-alice-other");
  assert.equal((await w.claim(THREAD_A, other, 1)).json.code, "namespace_not_premade");
  const unlabelled = w.cluster.premade(CLUSTER_A, "dyntest-alice-agent2", { "dynamo.nvidia.com/developer": DEVELOPER });
  w.guard.profiles = { ...PROFILES, bot: { ...PROFILES.bot, premade_namespace: unlabelled.name } };
  await w.tick();
  assert.equal((await w.claim(THREAD_A, unlabelled, 1)).json.code, "namespace_not_ours");
  w.guard.profiles = PROFILES;
  await w.tick();
  assert.equal((await w.claim(THREAD_A, w.ns, 1, { uid: "00000000-0000-4000-8000-00000000beef" })).json.code, "uid_mismatch");
  assert.equal(await used(w), 0);
});

test("a claim never falls back to the clusters setting: no profile read, no claim", async () => {
  const w = await world();
  w.guard.profiles = null;
  w.clock.advance(11 * MIN); // the kept profile read ages out
  await w.tick();
  const got = await w.claim(THREAD_A, w.ns, 1);
  assert.equal(got.json.code, "profiles_unavailable", JSON.stringify(got.json));
});

test("two simultaneous claims: one lease, one charge", async () => {
  const w = await world();
  const [a, b] = await Promise.all([w.claim(THREAD_A, w.ns, 2), w.claim(THREAD_B, w.ns, 2)]);
  assert.deepEqual([a.code, b.code].sort(), [0, 1]);
  assert.equal((a.code === 0 ? b : a).json.code, "namespace_leased");
  assert.equal(await used(w), 2);
});

test("the plugin killed before commit restarts with zero claims and zero charge", async () => {
  let crash = true;
  const w = await world({ admission: () => true, faults: { claim: (phase) => { if (crash && phase === "before-commit") throw new Error("killed"); } } });
  const got = await w.claim(THREAD_A, w.ns, 2, { request: "req_killedbefore1" });
  assert.notEqual(got.code, 0);
  crash = false;
  await w.reload();
  assert.equal((await w.cli(["leases", "--all", "--json"])).json.length, 0);
  assert.equal(await used(w), 0);
});

test("the plugin killed after commit restarts with exactly one recoverable claim and one charge", async () => {
  let crash = true;
  const w = await world({ admission: () => true, faults: { claim: (phase) => { if (crash && phase === "after-commit") throw new Error("killed"); } } });
  const lost = await w.claim(THREAD_A, w.ns, 2, { request: "req_killedafter01" });
  assert.notEqual(lost.code, 0, "the reply was lost");
  crash = false;
  await w.reload();
  await w.tick();
  const all = (await w.cli(["leases", "--all", "--json"])).json;
  assert.equal(all.length, 1);
  assert.equal(await used(w), 2);
  // The same request id returns the recorded outcome.
  const retried = await w.claim(THREAD_A, w.ns, 2, { request: "req_killedafter01" });
  assert.equal(retried.code, 0, JSON.stringify(retried.json));
  assert.equal(retried.json.lease_id, all[0].lease_id);
  // The same owner with a fresh request adopts it after losing its ledger; nobody else can.
  const adopted = await w.claim(THREAD_A, w.ns, 2, { request: "req_freshrequest1" });
  assert.equal(adopted.json.lease_id, all[0].lease_id);
  assert.equal(adopted.json.adopted, true);
  assert.equal((await w.claim(THREAD_B, w.ns, 2, { request: "req_someoneelse1" })).json.code, "namespace_leased");
  assert.equal((await w.claim(THREAD_A, w.ns, 3, { request: "req_otherterms01" })).json.code, "namespace_leased");
  assert.equal(await used(w), 2);
});

/** Claim, then return the lease and let teardown complete. */
async function claimAndEnd(w: World, thread: string, request: string, replaces = "none"): Promise<string> {
  const got = await w.claim(thread, w.ns, 1, { request, replaces });
  assert.equal(got.code, 0, JSON.stringify(got.json));
  const released = await w.cli(["lease", "release", got.json.lease_id], thread);
  assert.equal(released.json.state, "released", JSON.stringify(released.json));
  return got.json.lease_id;
}

test("reclaim replaces only the expected terminal predecessor, and history keeps a late request off the successor", async () => {
  const w = await world();
  const first = await claimAndEnd(w, THREAD_A, "req_firstclaim01");
  // A fresh request that expects no predecessor is stale.
  const stale = await w.claim(THREAD_B, w.ns, 1, { request: "req_stalereplace", replaces: "none" });
  assert.equal(stale.json.code, "predecessor_mismatch");
  assert.equal(stale.json.current, first);
  const second = await w.claim(THREAD_B, w.ns, 1, { request: "req_secondclaim1", replaces: first });
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.notEqual(second.json.lease_id, first);
  assert.equal((await show(w, second.json.lease_id)).predecessor, first);
  // A delayed retry of the first request returns its own, ended, outcome and touches nothing.
  const late = await w.claim(THREAD_A, w.ns, 1, { request: "req_firstclaim01" });
  assert.equal(late.json.lease_id, first);
  assert.equal(late.json.state, "released");
  // A delayed release of the first lease does nothing to the successor.
  await w.cli(["lease", "release", first], THREAD_A);
  assert.equal((await show(w, second.json.lease_id)).state, "active");
  assert.equal(await used(w), 1);
});

test("a write's attempt is recorded before it is sent, and blocks the next write while unresolved", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  const opened = await w.guard.claimedApply(id, THREAD_A, w.ns, "w", 2, "att_pausedwrite01", { pause: true });
  assert.equal(opened.code, 0, JSON.stringify(opened.json));
  const lease = await show(w, id);
  assert.deepEqual(lease.open_attempts.map((a: { attempt: string }) => a.attempt), ["att_pausedwrite01"]);
  // The guard died holding the slot. After its deadline, a new write still waits on the uncertain one.
  w.clock.advance(3 * MIN);
  const next = await w.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(next.json.code, "attempt_unresolved");
  // An attempt needs the slot it was opened under.
  const stray = await w.cli(["lease", "attempt", "begin", id, "tok_notmine", "--attempt", "att_strayattempt1", "--verb", "create", "--kind", "ConfigMap", "--name", "x"], THREAD_A);
  assert.equal(stray.json.code, "slot_lost");
});

test("an unresolved write crossing teardown: no completion, no successor; then commit, observe, drain, exactly one release", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  await w.guard.claimedApply(id, THREAD_A, w.ns, "w", 2, "att_crossingwrt1", { pause: true });
  // The guard is gone and its slot expires; the plugin restarts.
  w.clock.advance(3 * MIN);
  await w.reload();
  // The owner returns the lease. Teardown lists nothing of the lease: the write has not reached storage.
  const released = await w.cli(["lease", "release", id], THREAD_A);
  assert.equal(released.json.state, "releasing", JSON.stringify(released.json));
  await ticksUntil(w, () => false, 3);
  assert.equal((await show(w, id)).state, "releasing", "an empty list completed a teardown with a write in flight");
  assert.equal(await used(w), 2);
  assert.equal((await w.claim(THREAD_B, w.ns, 2, { request: "req_successor001", replaces: id })).json.code, "namespace_leased");
  // The write commits now; teardown observes its stamp, deletes it, and waits for its pod.
  w.cluster.landPending(w.ns, "att_crossingwrt1");
  await ticksUntil(w, () => false, 1);
  assert.equal((await show(w, id)).state, "releasing", "a leased pod still terminating must hold the charge");
  assert.equal((await show(w, id)).open_attempts.length, 0);
  w.cluster.settle();
  const n = await ticksUntil(w, () => w.guard.calls.some((c) => c.method === "down" && c.outcome === "complete"), 3);
  assert.ok(n > 0);
  const ended = await show(w, id);
  assert.equal(ended.state, "released");
  assert.equal(await used(w), 0);
  // Exactly one release: later ticks and replays change nothing, and the successor can claim once.
  await ticksUntil(w, () => false, 2);
  assert.equal((await show(w, id)).state, "released");
  const successor = await w.claim(THREAD_B, w.ns, 2, { request: "req_successor002", replaces: id });
  assert.equal(successor.code, 0, JSON.stringify(successor.json));
  assert.equal(await used(w), 2);
  assert.equal(w.ns.namespaceWrites, 0);
  assert.ok(w.cluster.get(CLUSTER_A, PREMADE), "the pre-made namespace is never deleted");
});

test("a crash after the last deletion and before completion: a restarted enforcer finishes without a Namespace write", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  await w.guard.claimedApply(id, THREAD_A, w.ns, "w", 2, "att_beforecrash1");
  w.cluster.settle();
  w.guard.loseNextDownResponse = true;
  await w.cli(["lease", "release", id], THREAD_A);
  assert.equal((await show(w, id)).state, "releasing");
  await w.reload();
  w.cluster.settle();
  await ticksUntil(w, () => false, 2);
  assert.equal((await show(w, id)).state, "released");
  assert.equal(w.ns.namespaceWrites, 0);
  assert.ok(w.cluster.get(CLUSTER_A, PREMADE));
});

test("a claimed lease never frees its GPUs because its namespace looks gone or re-created", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.failDown = true; // no teardown completes in this test
  await w.cli(["lease", "release", id], THREAD_A);
  w.cluster.namespaces.delete(w.cluster.key(CLUSTER_A, PREMADE));
  await ticksUntil(w, () => false, 3);
  assert.equal((await show(w, id)).state, "releasing");
  assert.equal(await used(w), 2);
  const recreated = w.cluster.premade(CLUSTER_A);
  assert.notEqual(recreated.uid, w.ns.uid);
  await ticksUntil(w, () => false, 2);
  assert.equal((await show(w, id)).state, "releasing");
});

test("a stale completion replay frees zero GPUs", () => {
  // The store alone, so the replay arrives exactly when the test says.
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  let t = T0;
  const store = createStore(db, () => t);
  const cfg: Config = {
    limits: { gb300: 4 }, maxLeaseMs: 4 * HOUR, maxRenewals: 1, graceMs: 60 * MIN, maxExtendMs: 24 * HOUR, clusters: {},
    firstRuns: {}, multiNode: [], hosts: [HOST_ONE], profilesCommand: "k8s-check",
    run: { command: "k8s-guard", serverUrl: "http://127.0.0.1:1", kubeconfig: null },
  };
  store.heartbeat(HOST_ONE, true, "ok");
  const uid = "00000000-0000-4000-8000-0000000000aa";
  const ask = { cluster: CLUSTER_A, context: CLUSTER_A, namespace: PREMADE, uid, gpuType: "gb300", gpus: 2, hours: 2, approvals: null };
  const first = store.claim({ ...ask, id: "lse_first00001", request: "req_storefirst01", thread: THREAD_A, replaces: null }, cfg, 10 * MIN, true).row;
  const epoch = first.attempt_epoch;
  store.release(first.id, THREAD_A, cfg);
  assert.equal(store.completeClaimed(first.id, uid, epoch, []).freed, 2);
  const second = store.claim({ ...ask, id: "lse_second0002", request: "req_storesecond1", thread: THREAD_B, replaces: first.id }, cfg, 10 * MIN, true).row;
  assert.equal(store.used("gb300"), 2);
  // The first completion, replayed: nothing changes.
  assert.equal(store.completeClaimed(first.id, uid, epoch, []).freed, 0);
  assert.equal(store.find(second.id)!.state, "active");
  assert.equal(store.used("gb300"), 2);
  // The successor's completion with an epoch from before its last attempt moved: nothing either.
  const stale = store.find(second.id)!.attempt_epoch;
  const slot = store.opBegin(second.id, THREAD_B, "tok_store000001", 2 * MIN, cfg);
  store.attemptBegin(second.id, THREAD_B, slot.token, { attempt: "att_storeattmpt1", verb: "create", kind: "ConfigMap", name: "c", uid: null, rv: null }, cfg);
  store.release(second.id, THREAD_B, cfg);
  t += MIN;
  assert.equal(store.completeClaimed(second.id, uid, stale, [{ attempt: "att_storeattmpt1", outcome: "failed" }]).freed, 0);
  assert.equal(store.used("gb300"), 2);
  // A refused completion applies nothing; the enforcer keeps the resolutions it was given.
  assert.equal(store.openAttempts(second.id).length, 1);
  store.resolveAttempts(second.id, [{ attempt: "att_storeattmpt1", outcome: "failed" }]);
  // With the epoch read after the resolution, it completes once.
  const fresh = store.find(second.id)!.attempt_epoch;
  assert.equal(store.completeClaimed(second.id, uid, fresh, []).freed, 2);
  assert.equal(store.completeClaimed(second.id, uid, fresh, []).freed, 0);
  assert.equal(store.used("gb300"), 0);
});
