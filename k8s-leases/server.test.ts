// The lease plugin's required cases, one test each, against a fake
// k8s-guard and a fake bb thread lookup. The parts that belong to the real
// guard or to the offline timer are modelled in test-support.ts; their own
// repository tests them.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLUSTER_A,
  CLUSTER_B,
  HOST_ONE,
  HOST_TWO,
  HOUR,
  MIN,
  THREAD_A,
  THREAD_B,
  setup,
  ticksUntil,
} from "./test-support.ts";

async function ready() {
  const world = await setup();
  await world.tick(); // first heartbeats
  return world;
}

async function state(world: Awaited<ReturnType<typeof setup>>, id: string): Promise<string> {
  const shown = await world.cli(["lease", "show", id]);
  assert.equal(shown.code, 0, JSON.stringify(shown.json));
  return shown.json.state;
}

test("two acquires at once that together exceed a limit: exactly one passes", async () => {
  const world = await ready();
  const one = world.cluster.create(CLUSTER_A, "dyntest-one", THREAD_A);
  const two = world.cluster.create(CLUSTER_B, "dyntest-two", THREAD_B);
  // gb300's limit is 4, over every cluster.
  const results = await Promise.all([world.acquire(THREAD_A, one, 3), world.acquire(THREAD_B, two, 3)]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
  const refused = results.find((r) => r.code !== 0)!;
  assert.equal(refused.json.code, "over_limit");
  assert.match(refused.json.error, /gb300/);
});

test("enrolling another thread's namespace: refused", async () => {
  const world = await ready();
  const theirs = world.cluster.create(CLUSTER_A, "dyntest-theirs", THREAD_B);
  // A's own thread on a namespace labelled for B.
  const own = await world.acquire(THREAD_A, theirs, 1);
  assert.equal(own.code, 1);
  assert.equal(own.json.code, "not_your_namespace");
  // Naming B as --thread from A's session.
  const posing = await world.acquire(THREAD_B, theirs, 1, { asThread: THREAD_A });
  assert.equal(posing.code, 1);
  assert.equal(posing.json.code, "not_your_thread");
});

test("a namespace with an active lease: a second lease refused", async () => {
  const world = await ready();
  const first = await world.lease(THREAD_A, "dyntest-busy", 1);
  assert.equal(first.result.code, 0, JSON.stringify(first.result.json));
  const second = await world.acquire(THREAD_A, first.ns, 1);
  assert.equal(second.code, 1);
  assert.equal(second.json.code, "namespace_leased");
});

test("a lease used against another cluster or namespace UID: refused, by the guard and on the host", async () => {
  const world = await ready();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-uid", THREAD_A);
  // At acquire: the UID passed in must be the one the host reads.
  const wrongUid = await world.acquire(THREAD_A, ns, 1, { uid: "11111111-2222-4333-8444-555555555555" });
  assert.equal(wrongUid.json.code, "uid_mismatch");
  const { id } = await world.lease(THREAD_A, "dyntest-uid", 1);
  // `show` gives the guard the cluster and UID to compare.
  const shown = (await world.cli(["lease", "show", id])).json;
  assert.equal(shown.cluster, CLUSTER_A);
  assert.equal(shown.uid, ns.uid);
  // The guard refuses the lease on another namespace's UID.
  const other = world.cluster.create(CLUSTER_B, "dyntest-uid", THREAD_A);
  const refused = await world.guard.handle(
    "expire",
    { run: {}, cluster: CLUSTER_B, namespace: other.name, uid: other.uid, leaseId: id },
    HOST_ONE,
  );
  assert.deepEqual((refused as { ok: boolean }).ok, false);
  // On the host: the namespace re-created under the same name gets no write.
  world.cluster.namespaces.delete(world.cluster.key(CLUSTER_A, "dyntest-uid"));
  const reborn = world.cluster.create(CLUSTER_A, "dyntest-uid", THREAD_A);
  world.cluster.setDgd(reborn, "worker", 4);
  world.clock.advance(3 * HOUR);
  await world.tick();
  assert.equal(world.guard.writes().filter((c) => c.cluster === CLUSTER_A && c.namespace === "dyntest-uid").length, 0);
  assert.equal(reborn.dgds.get("worker"), 4);
  assert.equal(await state(world, id), "torn-down");
});

test("return while busy: capacity stays charged until the pods are gone", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-ret", 4);
  world.cluster.setDgd(ns, "worker", 4);
  const released = await world.cli(["lease", "release", id], THREAD_A);
  assert.equal(released.json.state, "releasing");
  await world.tick(); // down runs; the pods are terminating
  const other = world.cluster.create(CLUSTER_A, "dyntest-next", THREAD_B);
  assert.equal((await world.acquire(THREAD_B, other, 1)).json.code, "over_limit");
  assert.equal(await state(world, id), "releasing");
  world.cluster.settle();
  await world.tick();
  assert.equal(await state(world, id), "released");
  assert.equal((await world.acquire(THREAD_B, other, 4)).code, 0);
});

test("delayed pod termination, and a failed cleanup followed by another acquire: capacity still charged", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-slow", 4);
  world.cluster.setDgd(ns, "worker", 4);
  world.guard.failDown = true;
  await world.cli(["lease", "release", id], THREAD_A);
  for (let n = 0; n < 3; n += 1) {
    world.clock.advance(MIN);
    await world.tick();
  }
  assert.equal(await state(world, id), "releasing");
  const flags = (await world.cli(["flags", "--json"])).json;
  assert.ok(flags.some((f: { kind: string; lease_id: string }) => f.kind === "teardown_failing" && f.lease_id === id));
  // Another acquire, on this namespace or any other: still charged.
  assert.equal((await world.acquire(THREAD_A, ns, 1)).json.code, "namespace_leased");
  const other = world.cluster.create(CLUSTER_B, "dyntest-other", THREAD_B);
  assert.equal((await world.acquire(THREAD_B, other, 1)).json.code, "over_limit");
  // The cleanup works now, but the pods take their time.
  world.guard.failDown = false;
  await world.tick();
  assert.ok(world.cluster.get(CLUSTER_A, "dyntest-slow")?.deleting);
  await world.tick();
  assert.equal(await state(world, id), "releasing");
  world.cluster.settle();
  await world.tick();
  assert.equal(await state(world, id), "released");
});

test("two writes at once on one lease: the second op begin is refused, and the combined allocation never exceeds the lease", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-two", 4);
  const first = await world.guard.apply(id, THREAD_A, ns, "a", 3, { pause: true });
  assert.ok(first.began);
  const second = await world.guard.apply(id, THREAD_A, ns, "b", 3);
  assert.equal(second.began, false);
  assert.equal(second.code, "slot_busy");
  await first.land();
  assert.equal(world.cluster.allocation(ns), 3);
  // `op end` frees the slot; the next write sees the first one's GPUs.
  const begin = await world.cli(["lease", "op", "begin", id], THREAD_A);
  assert.equal(begin.code, 1, "the first write never ended its slot");
  world.clock.advance(2 * MIN + 1000);
  const third = await world.guard.apply(id, THREAD_A, ns, "b", 3);
  assert.equal(third.code, "over_lease");
  assert.ok(world.cluster.allocation(ns) <= 4);
});

test("an apply paused after its final check, then expiry, then the apply lands and its client dies: within one tick of landing, the DGD is back at 0", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-late", 4, { hours: 1 });
  const paused = await world.guard.apply(id, THREAD_A, ns, "worker", 4, { pause: true });
  assert.ok(paused.began);
  world.clock.advance(HOUR);
  await world.tick();
  assert.equal(await state(world, id), "revoking");
  await paused.land(); // lands late; the client dies, so no op end
  assert.equal(ns.dgds.get("worker"), 4);
  world.clock.advance(MIN);
  await world.tick();
  assert.equal(ns.dgds.get("worker"), 0);
});

test("two applies whose slots overlap after a deadline, which together exceed the lease: the reconcile scales the namespace to 0 within one tick, and flags it", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-over", 4);
  const a = await world.guard.apply(id, THREAD_A, ns, "a", 4, { pause: true });
  world.clock.advance(2 * MIN + 1000); // A's slot lapses
  const b = await world.guard.apply(id, THREAD_A, ns, "b", 4, { pause: true });
  assert.ok(a.began && b.began);
  await a.land();
  await b.land();
  assert.equal(world.cluster.allocation(ns), 8);
  await world.tick();
  assert.equal(world.cluster.inspect(ns).dgd_gpus, 0);
  assert.equal(await state(world, id), "revoking");
  const flags = (await world.cli(["flags", "--json"])).json;
  assert.ok(flags.some((f: { kind: string; lease_id: string }) => f.kind === "over_allocation" && f.lease_id === id));
});

test("an owner's down on an active lease: the lease is released, then torn down, and its capacity is freed only after the pods are gone", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-own", 4);
  await world.guard.apply(id, THREAD_A, ns, "worker", 4);
  const down = await world.guard.ownerDown(id, THREAD_A, ns);
  assert.equal(down.json.state, "releasing");
  await world.tick();
  assert.equal(await state(world, id), "releasing");
  const other = world.cluster.create(CLUSTER_B, "dyntest-wait", THREAD_B);
  assert.equal((await world.acquire(THREAD_B, other, 1)).json.code, "over_limit");
  world.cluster.settle();
  await world.tick();
  assert.equal(await state(world, id), "released");
  assert.equal((await world.acquire(THREAD_B, other, 4)).code, 0);
});

test("expiry, return, and an archived thread: each torn down through k8s-guard expire and down, with no active lease", async () => {
  const world = await ready();
  const expiring = await world.lease(THREAD_A, "dyntest-exp", 1, { hours: 1 });
  const returning = await world.lease(THREAD_A, "dyntest-rtn", 1, { cluster: CLUSTER_B });
  const archived = await world.lease(THREAD_B, "dyntest-arc", 1, { gpuType: "h100" });
  for (const { id, ns } of [expiring, returning, archived]) await world.guard.apply(id, ns.thread!, ns, "worker", 1);
  world.threads.fates.set(THREAD_B, "archived");
  await world.cli(["lease", "release", returning.id], THREAD_A);
  world.clock.advance(HOUR);
  const n = await ticksUntil(
    world,
    () => {
      world.cluster.settle();
      return [expiring, returning, archived].every(({ ns }) => world.cluster.get(ns.cluster, ns.name) === undefined);
    },
    90,
  );
  assert.ok(n > 0, "every namespace was deleted");
  await world.tick();
  assert.equal(await state(world, expiring.id), "torn-down");
  assert.equal(await state(world, returning.id), "released");
  assert.equal(await state(world, archived.id), "torn-down");
  // Every write was accepted on the guard's own check: none needed an active lease.
  const writes = world.guard.writes().filter((c) => c.method === "expire" || c.method === "down");
  assert.ok(writes.some((c) => c.leaseId === expiring.id && c.method === "expire" && c.outcome === "ok"));
  assert.ok(writes.some((c) => c.leaseId === archived.id && c.method === "down" && c.outcome === "ok"));
  assert.ok(writes.some((c) => c.leaseId === returning.id && c.method === "down" && c.outcome === "ok"));
  assert.deepEqual(writes.filter((c) => c.outcome.startsWith("refused")), []);
});

test("a deletion whose response is lost, then the namespace re-created under the same name: the new namespace is untouched", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-lost", 1);
  world.guard.loseNextDownResponse = true;
  const released = await world.cli(["lease", "release", id], THREAD_A);
  assert.equal(released.json.state, "releasing");
  world.cluster.settle();
  assert.equal(world.cluster.get(CLUSTER_A, ns.name), undefined);
  const reborn = world.cluster.create(CLUSTER_A, ns.name, THREAD_B);
  world.cluster.setDgd(reborn, "worker", 2);
  const before = world.guard.calls.length;
  await world.tick();
  await world.tick();
  assert.equal(await state(world, id), "released");
  const touching = world.guard.calls.slice(before).filter((c) => c.method !== "inspect");
  assert.deepEqual(touching, []);
  assert.equal(reborn.dgds.get("worker"), 2);
  assert.equal(world.cluster.get(CLUSTER_A, ns.name), reborn);
});

test("the lease's own host down: another host tears it down", async () => {
  const world = await ready();
  const { id } = await world.lease(THREAD_A, "dyntest-host", 1, { hours: 1 });
  const first = world.guard.calls.find((c) => c.method === "inspect")!.hostId;
  const other = first === HOST_ONE ? HOST_TWO : HOST_ONE;
  world.guard.downHosts.add(first);
  world.clock.advance(HOUR);
  await world.tick();
  assert.equal(await state(world, id), "revoking");
  const expire = world.guard.calls.find((c) => c.method === "expire" && c.leaseId === id);
  assert.equal(expire?.hostId, other);
  assert.equal(expire?.outcome, "ok");
});

test("the plugin or the server down: the host timer scales to 0 at expiry, deletes after the grace period, and acquire fails closed", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-off", 4, { hours: 1 });
  await world.guard.apply(id, THREAD_A, ns, "worker", 4);
  await world.tick(); // the namespace's expires-at follows the lease
  const shown = (await world.cli(["lease", "show", id])).json;
  assert.equal(ns.expiresAt, shown.expires_at);
  // bb goes away: no ticks, no `lease show`. Only the offline timer runs.
  world.guard.bbOffline = true;
  world.clock.advance(HOUR - MIN);
  world.guard.offlineTimerRun(HOUR);
  assert.equal(ns.dgds.get("worker"), 4, "not before expiry");
  world.clock.advance(MIN);
  world.guard.offlineTimerRun(HOUR);
  assert.equal(ns.dgds.get("worker"), 0);
  assert.ok(!ns.deleting);
  world.clock.advance(HOUR);
  world.guard.offlineTimerRun(HOUR);
  assert.ok(ns.deleting);
  // No host has sent a heartbeat for 10 minutes: acquire fails closed.
  world.guard.downHosts.add(HOST_ONE).add(HOST_TWO);
  await world.tick();
  const fresh = world.cluster.create(CLUSTER_B, "dyntest-closed", THREAD_B);
  assert.equal((await world.acquire(THREAD_B, fresh, 1)).json.code, "enforcement_unhealthy");
});

test("acquire fails closed after 10 minutes without a heartbeat, and opens again on one", async () => {
  const world = await ready();
  world.guard.downHosts.add(HOST_ONE).add(HOST_TWO);
  world.clock.advance(9 * MIN);
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-hb", THREAD_A);
  world.guard.downHosts.delete(HOST_TWO); // reachable for the inspect, but no probe yet
  assert.equal((await world.acquire(THREAD_A, ns, 1)).code, 0, "9 minutes: still healthy");
  world.guard.downHosts.add(HOST_TWO);
  world.clock.advance(2 * MIN);
  await world.tick();
  world.guard.downHosts.delete(HOST_TWO);
  const late = world.cluster.create(CLUSTER_A, "dyntest-hb2", THREAD_A);
  assert.equal((await world.acquire(THREAD_A, late, 1)).json.code, "enforcement_unhealthy");
  await world.tick();
  assert.equal((await world.acquire(THREAD_A, late, 1)).code, 0);
});

test("a restart during the grace period: deletion still happens on time", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-rst", 1, { hours: 1 });
  world.clock.advance(HOUR);
  await world.tick();
  assert.equal(await state(world, id), "revoking");
  world.clock.advance(30 * MIN);
  await world.reload();
  await world.tick();
  assert.ok(!world.guard.calls.some((c) => c.method === "down" && c.leaseId === id), "not before the grace deadline");
  world.clock.advance(29 * MIN);
  await world.tick();
  assert.ok(!world.guard.calls.some((c) => c.method === "down" && c.leaseId === id));
  world.clock.advance(MIN);
  await world.tick();
  assert.ok(world.guard.calls.some((c) => c.method === "down" && c.leaseId === id && c.outcome === "ok"));
  assert.ok(ns.deleting);
});

test("n above one node's GPUs with no multi-node approval: refused", async () => {
  const world = await setup({ gpuLimits: JSON.stringify({ gb300: 16 }) });
  await world.tick();
  const ns = world.cluster.create(CLUSTER_A, "dyntest-big", THREAD_A);
  const refused = await world.acquire(THREAD_A, ns, 8);
  assert.equal(refused.json.code, "multi_node_unapproved");
  await world.harness.behavior.setSettings({
    multiNodeApprovals: JSON.stringify([{ cluster: CLUSTER_A, namespace: ns.name, thread: THREAD_A, maxGpus: 8, record: "approved in test" }]),
  });
  const approved = await world.acquire(THREAD_A, ns, 8);
  assert.equal(approved.code, 0, JSON.stringify(approved.json));
  assert.equal((await world.cli(["lease", "show", approved.json.lease_id])).json.multi_node, true);
});

test("an extension from the panel: the expiry and the namespace's expires-at both move, and the offline timer does not act early; an extension of a revoking lease: refused", async () => {
  const world = await ready();
  const { id, ns } = await world.lease(THREAD_A, "dyntest-ext", 4, { hours: 1 });
  await world.guard.apply(id, THREAD_A, ns, "worker", 4);
  await world.tick();
  const before = Date.parse((await world.cli(["lease", "show", id])).json.expires_at);
  assert.equal(Date.parse(ns.expiresAt!), before);
  const extended = (await world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 120 })) as { expiresAt: number; synced: boolean };
  assert.equal(extended.expiresAt, before + 2 * HOUR);
  assert.equal(extended.synced, true);
  assert.equal(Date.parse(ns.expiresAt!), before + 2 * HOUR);
  // Past the old expiry: the offline timer and the plugin both leave it alone.
  world.clock.advance(HOUR + MIN);
  world.guard.bbOffline = true;
  world.guard.offlineTimerRun(HOUR);
  world.guard.bbOffline = false;
  await world.tick();
  assert.equal(ns.dgds.get("worker"), 4);
  assert.equal(await state(world, id), "active");
  const snapshot = (await world.harness.behavior.callRpc("snapshot", null)) as { leases: Array<{ id: string; extensions: unknown[] }> };
  assert.equal(snapshot.leases.find((l) => l.id === id)!.extensions.length, 1);
  // Revoked: no extension.
  world.clock.advance(2 * HOUR);
  await world.tick();
  assert.equal(await state(world, id), "revoking");
  await assert.rejects(world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 }), /revoking/);
  const view = ((await world.harness.behavior.callRpc("snapshot", null)) as { leases: Array<{ id: string; extendBlocked: string | null }> }).leases.find(
    (l) => l.id === id,
  )!;
  assert.match(view.extendBlocked ?? "", /expired/);
});
