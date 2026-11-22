// The lease fence (phase 2): a Kyverno policy, scoped to the enrolled pre-made
// namespace, admits Pods only under the lease its gate ConfigMap names. The
// plugin's part:
// - every fresh claim asks one host for `fence probe`, and refuses unless the
//   probe reads an enforcing, fine-grained fence (a trial: audit, fine-grained);
// - the namespace must carry the enrollment label;
// - each claim gets a sequence number that only rises on its namespace;
// - a claimed teardown completes only when the guard reports its own gate
//   closed for this lease and seq, a drain of at least the plugin's own W, and
//   a fence armed throughout (or retired, with a recorded proof);
// - the enforcer probes each live claimed lease every fifth tick;
// - the cause the guard gives for a fence not armed travels with the charge:
//   in the claim's refusal, in the fence_disarmed flag, and in the lease's note.
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Config } from "./lib/settings.ts";
import { DRAIN_MS, MAX_PROBE_GAP_MS, MIGRATIONS, createStore, type FenceReport } from "./lib/store.ts";
import {
  ARMED,
  AUDIT,
  CLAIM_PROFILES,
  CLUSTER_A,
  DEVELOPER,
  DISARMED,
  ENGINE_DOWN,
  FENCE_LABEL,
  HOST_ONE,
  HOUR,
  MIN,
  PREMADE,
  SCALED_TO_ZERO,
  SHARED,
  T0,
  THREAD_A,
  THREAD_B,
  setup,
  ticksUntil,
  verdict,
  type ProbeAnswer,
  type SetupOptions,
} from "./test-support.ts";

const PROOF = "https://example.test/incidents/fence-retired-1";

async function world(options: SetupOptions = { fence: ARMED }, settings: Record<string, string> = {}) {
  const w = await setup(settings, options);
  w.guard.profiles = CLAIM_PROFILES;
  await w.tick(); // heartbeats and the profile read
  const ns = w.cluster.premade(CLUSTER_A);
  const probes = () => w.guard.calls.filter((c) => c.method === "probe-fence").length;
  const flags = async (kind: string) => ((await w.cli(["flags", "--json"])).json as Array<{ kind: string; lease_id: string; detail: string }>).filter((f) => f.kind === kind);
  const show = async (id: string) => {
    const shown = await w.cli(["lease", "show", id]);
    assert.equal(shown.code, 0, JSON.stringify(shown.json));
    return shown.json;
  };
  const used = async () => ((await w.cli(["leases", "--json"])).json as Array<{ gpus: number }>).reduce((sum, row) => sum + row.gpus, 0);
  return Object.assign(w, { ns, probes, flags, show, used });
}

// --- the claim's gate ---

const REFUSED: Array<[string, ProbeAnswer]> = [
  ["disarmed", DISARMED],
  ["shared", SHARED],
  ["audit, for a normal claim", AUDIT],
  ["engine_unavailable mode", ENGINE_DOWN],
  // The mode Pod is refused by our entry, but the canary is admitted: the canary policy is gone.
  ["canary_absent", { canary: "disarmed", mode: "enforcing", scope: "finegrained", armed: false, mode_entry: "finegrained", cause: "canary_absent: the canary policy's entry did not answer" }],
  // Kyverno is down: our entry refuses by name, so the fence holds, but an outage is no time to claim.
  ["canary engine_unavailable with mode enforcing", verdict("engine_unavailable", "enforcing")],
  ["probe failure", "fail"],
];

for (const [name, answer] of REFUSED) {
  test(`a claim refuses enforcement_unhealthy when the fence probe reads ${name}, and quotes the probe`, async () => {
    const w = await world();
    w.guard.setProbe(w.ns, answer);
    const got = await w.claim(THREAD_A, w.ns, 2);
    assert.equal(got.code, 1, JSON.stringify(got.json));
    assert.equal(got.json.code, "enforcement_unhealthy");
    assert.match(got.json.error, /fence probe/);
    if (answer === "fail") {
      assert.match(got.json.error, /unknown command 'fence'/);
    } else {
      assert.match(got.json.error, new RegExp(`canary ${answer.canary}, mode ${answer.mode}, scope ${answer.scope}`));
      assert.match(got.json.error, new RegExp(`canary: ${answer.canary} \\(server text\\)`));
      assert.deepEqual([got.json.canary, got.json.mode, got.json.scope], [answer.canary, answer.mode, answer.scope]);
      if (answer.cause !== undefined) {
        // The cause travels with the refusal, in its words and as a field.
        assert.equal(got.json.cause, answer.cause);
        assert.ok(got.json.error.includes(answer.cause), got.json.error);
      }
    }
    assert.equal(await w.used(), 0);
    assert.equal((await w.cli(["leases", "--all", "--json"])).json.length, 0);
  });
}

test("an enforcing, fine-grained probe allows a claim; one probe on one host per fresh claim, none for a replay", async () => {
  const w = await world();
  const got = await w.claim(THREAD_A, w.ns, 2, { request: "req_fenceallow001" });
  assert.equal(got.code, 0, JSON.stringify(got.json));
  assert.equal(got.json.seq, 1);
  assert.equal(got.json.trial, false);
  assert.equal(w.probes(), 1);
  // The probe takes the kube context and the namespace, nothing else.
  const call = w.guard.calls.find((c) => c.method === "probe-fence")!;
  assert.deepEqual([call.cluster, call.namespace, call.uid, call.leaseId], [CLUSTER_A, PREMADE, undefined, undefined]);
  // A replay returns its recorded outcome first, whatever the fence reads now.
  w.guard.setProbe(w.ns, DISARMED);
  const replay = await w.claim(THREAD_A, w.ns, 2, { request: "req_fenceallow001" });
  assert.equal(replay.code, 0, JSON.stringify(replay.json));
  assert.deepEqual([replay.json.lease_id, replay.json.seq, replay.json.trial], [got.json.lease_id, 1, false]);
  assert.equal(w.probes(), 1);
  // A fresh request of the same owner (an adopt) is a fresh claim: it probes, and refuses on a disarmed fence.
  const adopt = await w.claim(THREAD_A, w.ns, 2, { request: "req_fenceadopt001" });
  assert.equal(adopt.json.code, "enforcement_unhealthy", JSON.stringify(adopt.json));
  assert.equal(w.probes(), 2);
});

test("the fence gate is a code option: a test gate can allow what the contract's rule refuses", async () => {
  const w = await world({ fence: DISARMED, fenceGate: () => true });
  const got = await w.claim(THREAD_A, w.ns, 1);
  assert.equal(got.code, 0, JSON.stringify(got.json));
  // A probe that could not run refuses whatever the gate says.
  w.guard.setProbe(w.ns, "fail");
  assert.equal((await w.claim(THREAD_B, w.ns, 1, { replaces: got.json.lease_id })).json.code, "enforcement_unhealthy");
});

// --- the trial ---

test("a trial claim needs --claim and --gpus 1, and is allowed only under audit with scope finegrained", async () => {
  const w = await world({ fence: AUDIT });
  const two = await w.claim(THREAD_A, w.ns, 2, { trial: true });
  assert.equal(two.json.code, "invalid_argument", JSON.stringify(two.json));
  assert.match(two.json.error, /--gpus 1/);
  // --audit-trial belongs to a claim, not to a namespace the guard made.
  const made = w.cluster.create(CLUSTER_A, "dyntest-alice-made", THREAD_A);
  const plain = await w.cli(
    ["lease", "acquire", "--cluster", CLUSTER_A, "--namespace", made.name, "--uid", made.uid, "--thread", THREAD_A, "--gpu-type", "gb300", "--gpus", "1", "--hours", "1", "--audit-trial"],
    THREAD_A,
  );
  assert.equal(plain.json.code, "invalid_argument", JSON.stringify(plain.json));
  // A normal claim under an audit-mode policy refuses.
  assert.equal((await w.claim(THREAD_A, w.ns, 1)).json.code, "enforcement_unhealthy");
  // A trial under an enforcing policy, or with a shared webhook, refuses.
  w.guard.setProbe(w.ns, ARMED);
  const enforcing = await w.claim(THREAD_A, w.ns, 1, { trial: true });
  assert.equal(enforcing.json.code, "enforcement_unhealthy", JSON.stringify(enforcing.json));
  assert.match(enforcing.json.error, /trial/);
  w.guard.setProbe(w.ns, verdict("shared", "audit"));
  assert.equal((await w.claim(THREAD_A, w.ns, 1, { trial: true })).json.code, "enforcement_unhealthy");
  // Audit with a fine-grained webhook: the trial is granted, as a trial.
  w.guard.setProbe(w.ns, AUDIT);
  const trial = await w.claim(THREAD_A, w.ns, 1, { trial: true });
  assert.equal(trial.code, 0, JSON.stringify(trial.json));
  assert.deepEqual([trial.json.seq, trial.json.trial], [1, true]);
  const shown = await w.show(trial.json.lease_id);
  assert.deepEqual([shown.claim_seq, shown.trial, shown.gpus], [1, true, 1]);
  // A normal claim never adopts a trial lease, and its replay keeps saying trial.
  assert.equal((await w.claim(THREAD_A, w.ns, 1, { request: "req_notatrial0001" })).json.code, "enforcement_unhealthy");
  w.guard.setProbe(w.ns, ARMED);
  assert.equal((await w.claim(THREAD_A, w.ns, 1, { request: "req_notatrial0002" })).json.code, "namespace_leased");
});

test("a trial claim needs the owner's first-run approval for the cluster, before any probe", async () => {
  const w = await world({ fence: AUDIT }, { firstRunApprovals: JSON.stringify({}) });
  const got = await w.claim(THREAD_A, w.ns, 1, { trial: true });
  assert.equal(got.json.code, "first_run_unapproved", JSON.stringify(got.json));
  assert.equal(w.probes(), 0);
});

// --- enrollment ---

test("a claim refuses namespace_not_enrolled unless the namespace carries the fence label, from the plugin's own inspect", async () => {
  const w = await world();
  const labels = { "dynamo.nvidia.com/developer": DEVELOPER, "dynamo.nvidia.com/developer-agent-rbac": "true" };
  for (const [name, extra] of [["dyntest-alice-nolabel", {}], ["dyntest-alice-false", { [FENCE_LABEL]: "false" }]] as const) {
    const ns = w.cluster.premade(CLUSTER_A, name, { ...labels, ...extra });
    w.guard.profiles = { ...CLAIM_PROFILES, bot: { ...CLAIM_PROFILES.bot, premade_namespace: name } };
    await w.tick();
    const got = await w.claim(THREAD_A, ns, 1);
    assert.equal(got.json.code, "namespace_not_enrolled", JSON.stringify(got.json));
    assert.match(got.json.error, new RegExp(FENCE_LABEL));
  }
  // Checked before the probe: an unlabelled namespace is not a broken fence.
  assert.equal(w.probes(), 0);
  assert.equal(await w.used(), 0);
});

// --- seq ---

test("seq rises across a replace, an adopt keeps its seq, and a replay returns its first seq", async () => {
  const w = await world();
  const first = await w.claim(THREAD_A, w.ns, 1, { request: "req_seqfirst00001" });
  assert.equal(first.json.seq, 1);
  const adopted = await w.claim(THREAD_A, w.ns, 1, { request: "req_seqadopt00001" });
  assert.deepEqual([adopted.json.lease_id, adopted.json.adopted, adopted.json.seq], [first.json.lease_id, true, 1]);
  assert.equal((await w.cli(["lease", "release", first.json.lease_id], THREAD_A)).json.state, "released");
  const second = await w.claim(THREAD_B, w.ns, 1, { request: "req_seqsecond0001", replaces: first.json.lease_id });
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(second.json.seq, 2);
  assert.equal((await w.show(second.json.lease_id)).claim_seq, 2);
  const late = await w.claim(THREAD_A, w.ns, 1, { request: "req_seqfirst00001" });
  assert.deepEqual([late.json.lease_id, late.json.state, late.json.seq], [first.json.lease_id, "released", 1]);
  assert.equal((await w.cli(["lease", "release", second.json.lease_id], THREAD_B)).json.state, "released");
  const third = await w.claim(THREAD_A, w.ns, 1, { request: "req_seqthird00001", replaces: second.json.lease_id });
  assert.equal(third.json.seq, 3);
});

test("seq is per namespace name, across kube contexts, and is never reused", () => {
  const { store, cfg, ask } = storeWorld();
  const a = store.claim({ ...ask, id: "lse_seqstore0001", request: "req_seqstore00001", replaces: null }, cfg, 10 * MIN).row;
  const other = store.claim({ ...ask, namespace: "dyntest-alice-two", uid: "00000000-0000-4000-8000-0000000000c2", id: "lse_seqstore0002", request: "req_seqstore00002", replaces: null }, cfg, 10 * MIN).row;
  assert.deepEqual([a.claim_seq, other.claim_seq], [1, 1]);
  store.release(a.id, THREAD_A, cfg);
  assert.equal(store.completeClaimed(a.id, ask.uid, store.find(a.id)!.attempt_epoch, [], { fence: { lease_id: a.id, seq: 1, state: "closing" }, drain_monotonic_seconds: 120, max_probe_gap_seconds: 5, armed: "continuous", lease_fence: "true" }).freed, 2);
  // The cluster's kube context is renamed: the next claim of the same namespace still counts on from 1.
  const renamed = store.claim({ ...ask, context: "renamed-context-a", id: "lse_seqstore0003", request: "req_seqstore00003", replaces: null }, cfg, 10 * MIN).row;
  assert.equal(renamed.claim_seq, 2);
  // The unique index holds across contexts and states.
  assert.throws(() => store.db.prepare("INSERT INTO leases (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state, mode, claim_seq) VALUES ('lse_dupseq00001', ?, ?, 'another-context', ?, 'u', 'gb300', 1, 1, 0, 0, 1, 'released', 'claimed', 1)").run(THREAD_B, CLUSTER_A, PREMADE), /UNIQUE/);
});

// --- completion ---

function storeWorld(drainMs?: number, maxProbeGapMs?: number) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = Object.assign(createStore(db, () => T0, { ...(drainMs === undefined ? {} : { drainMs }), ...(maxProbeGapMs === undefined ? {} : { maxProbeGapMs }) }), { db });
  const cfg: Config = {
    limits: { gb300: 8 }, maxLeaseMs: 4 * HOUR, maxRenewals: 1, graceMs: 60 * MIN, maxExtendMs: 24 * HOUR, clusters: {},
    firstRuns: {}, multiNode: [], hosts: [HOST_ONE], profilesCommand: "k8s-check",
    run: { command: "k8s-guard", serverUrl: "http://127.0.0.1:1", kubeconfig: null },
  };
  store.heartbeat(HOST_ONE, true, "ok");
  const ask = { cluster: CLUSTER_A, context: CLUSTER_A, namespace: PREMADE, uid: "00000000-0000-4000-8000-0000000000c1", gpuType: "gb300", gpus: 2, hours: 2, approvals: null, thread: THREAD_A, trial: false };
  return { store, cfg, ask };
}

/** A released claimed lease and the report of a teardown that did everything right. */
function closing(drainMs?: number, maxProbeGapMs?: number) {
  const { store, cfg, ask } = storeWorld(drainMs, maxProbeGapMs);
  // A predecessor, so the lease under test has seq 2 and a seq of 1 is stale.
  const before = store.claim({ ...ask, id: "lse_before000001", request: "req_before0000001", replaces: null }, cfg, 10 * MIN).row;
  store.release(before.id, THREAD_A, cfg);
  const good = (id: string, seq: number): FenceReport => ({ fence: { lease_id: id, seq, state: "closing" }, drain_monotonic_seconds: 120, max_probe_gap_seconds: 5, armed: "continuous", lease_fence: "true" });
  assert.equal(store.completeClaimed(before.id, ask.uid, store.find(before.id)!.attempt_epoch, [], good(before.id, 1)).freed, 2);
  const row = store.claim({ ...ask, id: "lse_closing00001", request: "req_closing000001", replaces: before.id }, cfg, 10 * MIN).row;
  assert.equal(row.claim_seq, 2);
  store.release(row.id, THREAD_A, cfg);
  const complete = (report: FenceReport) => store.completeClaimed(row.id, ask.uid, store.find(row.id)!.attempt_epoch, [], report);
  return { store, cfg, row, report: good(row.id, 2), complete };
}

const MISSING: Array<[string, (r: FenceReport) => FenceReport]> = [
  ["no fence read back", ({ fence: _, ...rest }) => rest],
  ["a fence still active", (r) => ({ ...r, fence: { ...r.fence!, state: "active" } })],
  ["a fence with a stale seq", (r) => ({ ...r, fence: { ...r.fence!, seq: 1 } })],
  ["a fence with a later seq", (r) => ({ ...r, fence: { ...r.fence!, seq: 3 } })],
  ["a fence for another lease", (r) => ({ ...r, fence: { ...r.fence!, lease_id: "lse_before000001" } })],
  ["no drain", ({ drain_monotonic_seconds: _, ...rest }) => rest],
  ["a drain one tenth of a second short of W", (r) => ({ ...r, drain_monotonic_seconds: DRAIN_MS / 1000 - 0.1 })],
  ["a host-reported short drain (the guard's drain set to 30 s)", (r) => ({ ...r, drain_monotonic_seconds: 30 })],
  ["no armed", ({ armed: _, ...rest }) => rest],
  ["armed: retired without a recorded proof", (r) => ({ ...r, armed: "retired", lease_fence: null })],
  ["no probe gap reported", ({ max_probe_gap_seconds: _, ...rest }) => rest],
  ["a probe gap of 8.1 s", (r) => ({ ...r, max_probe_gap_seconds: 8.1 })],
];

for (const [name, spoil] of MISSING) {
  test(`completeClaimed frees nothing with ${name}`, () => {
    const { store, row, report, complete } = closing();
    const got = complete(spoil(report));
    assert.deepEqual([got.completed, got.freed], [false, 0]);
    assert.ok(got.why, "a refused completion says why");
    assert.equal(store.find(row.id)!.state, "releasing");
    assert.equal(store.used("gb300"), 2);
    // The same teardown with every condition met completes once.
    assert.deepEqual(complete(report), { completed: true, freed: 2 });
    assert.deepEqual(complete(report).freed, 0);
  });
}

test("W is the plugin's own constant, 120 s; only a code option moves it", () => {
  assert.equal(DRAIN_MS, 120_000);
  const { complete, report } = closing(30_000);
  assert.equal(complete({ ...report, drain_monotonic_seconds: 30 }).freed, 2);
});

test("the probe gap is the plugin's own limit, 8 s: 8.0 completes; only a code option moves it", () => {
  assert.equal(MAX_PROBE_GAP_MS, 8_000);
  const { complete, report } = closing();
  assert.deepEqual(complete({ ...report, max_probe_gap_seconds: 8.0 }), { completed: true, freed: 2 });
  const loose = closing(undefined, 20_000);
  assert.equal(loose.complete({ ...loose.report, max_probe_gap_seconds: 15 }).freed, 2);
});

test("armed: retired takes no probes: it completes without a probe gap", () => {
  const { store, row, report, complete } = closing();
  store.recordFenceRetired(row.id, PROOF);
  const { max_probe_gap_seconds: _, ...rest } = report;
  assert.deepEqual(complete({ ...rest, armed: "retired", lease_fence: null }), { completed: true, freed: 2 });
});

test("armed: retired completes only with a recorded proof and an unenrolled lease_fence, and flags fence_retired_completion", () => {
  const { store, row, report, complete } = closing();
  const retired: FenceReport = { ...report, armed: "retired", lease_fence: null };
  assert.equal(complete(retired).freed, 0, "no proof recorded");
  store.recordFenceRetired(row.id, PROOF);
  assert.equal(complete({ ...retired, lease_fence: "true" }).freed, 0, "the namespace is still enrolled");
  const { lease_fence: _, ...unread } = retired;
  assert.equal(complete(unread).freed, 0, "the report did not say whether the namespace is enrolled");
  assert.equal(store.flags().filter((f) => f.kind === "fence_retired_completion").length, 0);
  assert.deepEqual(complete({ ...retired, lease_fence: "false" }), { completed: true, freed: 2 });
  const flagged = store.flags().filter((f) => f.kind === "fence_retired_completion");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.lease_id, row.id);
  assert.match(flagged[0]!.detail, new RegExp(PROOF.replace(/[.]/g, "\\.")));
});

// --- through the enforcer ---

test("a claimed teardown that finds the fence disarmed flags fence_disarmed once and frees nothing; re-armed, it completes", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.setProbe(w.ns, DISARMED);
  assert.equal((await w.cli(["lease", "release", id], THREAD_A)).json.state, "releasing");
  await ticksUntil(w, () => false, 2);
  assert.equal((await w.show(id)).state, "releasing");
  assert.equal(await w.used(), 2);
  const flags = await w.flags("fence_disarmed");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.lease_id, id);
  assert.match(flags[0]!.detail, /canary disarmed/);
  // The guard's cause is in the flag, and in the note a stuck lease shows.
  assert.ok(flags[0]!.detail.includes(SCALED_TO_ZERO), flags[0]!.detail);
  const shown = await w.show(id);
  assert.ok(String(shown.last_error).includes(SCALED_TO_ZERO), String(shown.last_error));
  // Exit 1: ops re-arm the fence; the next teardown completes.
  w.guard.setProbe(w.ns, ARMED);
  assert.ok((await ticksUntil(w, () => w.guard.calls.some((c) => c.method === "down" && c.outcome === "complete"), 2)) > 0);
  assert.equal((await w.show(id)).state, "released");
  assert.equal(await w.used(), 0);
});

test("a teardown stopped by a probe gap flags fence_disarmed with the gap line, and the note keeps it", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  const gap = "probes were 9.0 s apart, more than the 8 s limit: a fence state between them went unseen";
  w.guard.setProbe(w.ns, { ...verdict("finegrained", "enforcing"), armed: false, cause: gap });
  await w.cli(["lease", "release", id], THREAD_A);
  const flags = await w.flags("fence_disarmed");
  assert.equal(flags.length, 1);
  assert.ok(flags[0]!.detail.includes(gap), flags[0]!.detail);
  assert.ok(String((await w.show(id)).last_error).includes(gap));
  assert.equal(await w.used(), 2);
});

test("a teardown whose probe gives no cause says so: the fence was not armed (no cause given)", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.setProbe(w.ns, verdict("disarmed", "absent", null));
  await w.cli(["lease", "release", id], THREAD_A);
  const flags = await w.flags("fence_disarmed");
  assert.equal(flags.length, 1);
  assert.match(flags[0]!.detail, /the fence was not armed \(no cause given\)/);
  assert.match(String((await w.show(id)).last_error), /the fence was not armed \(no cause given\)/);
});

test("a complete teardown whose report misses a condition frees nothing and keeps a note", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.downReport = { drain_monotonic_seconds: 30 };
  await w.cli(["lease", "release", id], THREAD_A);
  const shown = await w.show(id);
  assert.equal(shown.state, "releasing");
  assert.equal(await w.used(), 2);
  w.guard.downReport = { fence: { lease_id: id, seq: 99, state: "closing" } };
  await ticksUntil(w, () => false, 1);
  assert.equal((await w.show(id)).state, "releasing");
  w.guard.downReport = {};
  await ticksUntil(w, () => false, 1);
  assert.equal((await w.show(id)).state, "released");
});

test("the tick probes each live claimed lease only every fifth tick, and raises fence_disarmed_live once", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  assert.equal(w.probes(), 1, "the claim's own probe");
  await ticksUntil(w, () => false, 4);
  assert.equal(w.probes(), 1);
  await ticksUntil(w, () => false, 1);
  assert.equal(w.probes(), 2, "the fifth tick probes");
  assert.equal((await w.flags("fence_disarmed_live")).length, 0);
  w.guard.setProbe(w.ns, verdict("finegrained", "audit"));
  await ticksUntil(w, () => false, 4);
  assert.equal(w.probes(), 2);
  await ticksUntil(w, () => false, 1);
  assert.equal(w.probes(), 3);
  const flags = await w.flags("fence_disarmed_live");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.lease_id, id);
  assert.match(flags[0]!.detail, /mode audit/);
  assert.match(flags[0]!.detail, /fake cause: canary finegrained, mode audit/);
  await ticksUntil(w, () => false, 5);
  assert.equal(w.probes(), 4);
  assert.equal((await w.flags("fence_disarmed_live")).length, 1, "flagged once");
  assert.equal((await w.flags("fence_disarmed")).length, 0, "the live probe keeps its own kind");
  // It frees nothing: the lease stays active and charged.
  assert.equal((await w.show(id)).state, "active");
  assert.equal(await w.used(), 2);
  // A lease that is not claimed is never probed.
  await w.lease(THREAD_B, "dyntest-made-one", 1);
  const before = w.probes();
  await ticksUntil(w, () => false, 5);
  assert.equal(w.probes(), before + 1);
});

test("a live probe's flag never hides the teardown's: fence_disarmed is raised at teardown after fence_disarmed_live", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.setProbe(w.ns, DISARMED);
  await ticksUntil(w, () => false, 5);
  assert.equal((await w.flags("fence_disarmed_live")).length, 1);
  await w.cli(["lease", "release", id], THREAD_A);
  const teardown = await w.flags("fence_disarmed");
  assert.equal(teardown.length, 1);
  assert.equal(teardown[0]!.lease_id, id);
  assert.match(teardown[0]!.detail, /its teardown found the fence not armed/);
  assert.ok(teardown[0]!.detail.includes(SCALED_TO_ZERO));
});

test("a live probe that cannot run raises fence_probe_failed with its error, not a disarmed flag", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.setProbe(w.ns, "fail");
  await ticksUntil(w, () => false, 5);
  assert.equal((await w.flags("fence_disarmed_live")).length, 0);
  assert.equal((await w.flags("fence_disarmed")).length, 0);
  const flags = await w.flags("fence_probe_failed");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.lease_id, id);
  assert.match(flags[0]!.detail, /unknown command 'fence'/);
  assert.equal((await w.show(id)).state, "active");
});

// --- a retired fence (exit 2) ---

test("fence-retired refuses from a bb thread, records a proof for a claimed lease in teardown, and the next down passes it", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  // Only a lease in teardown takes a proof.
  assert.equal((await w.cli(["lease", "fence-retired", id, "--proof", PROOF])).json.code, "lease_not_in_teardown");
  w.guard.setProbe(w.ns, DISARMED);
  await w.cli(["lease", "release", id], THREAD_A);
  assert.equal((await w.flags("fence_disarmed")).length, 1);
  // From a thread: refused, whoever owns the lease.
  for (const thread of [THREAD_A, THREAD_B]) {
    const fromThread = await w.cli(["lease", "fence-retired", id, "--proof", PROOF], thread);
    assert.equal(fromThread.json.code, "not_from_thread", JSON.stringify(fromThread.json));
  }
  assert.equal((await w.cli(["lease", "fence-retired", id, "--proof", "not a url"])).json.code, "invalid_argument");
  assert.equal((await w.cli(["lease", "fence-retired", "lse_nosuchlease1", "--proof", PROOF])).json.code, "lease_not_found");
  assert.equal((await w.show(id)).fence_retired_proof, null);
  const recorded = await w.cli(["lease", "fence-retired", id, "--proof", PROOF]);
  assert.equal(recorded.code, 0, JSON.stringify(recorded.json));
  assert.deepEqual(recorded.json, { lease_id: id, fence_retired_proof: PROOF });
  assert.equal((await w.show(id)).fence_retired_proof, PROOF);
  // The label is still on the namespace: the guard refuses fence_not_retired, and nothing is freed.
  await ticksUntil(w, () => false, 1);
  const retiredDowns = () => w.guard.calls.filter((c) => c.method === "down" && c.leaseId === id && c.fenceRetired === PROOF);
  assert.ok(retiredDowns().length > 0, "the down did not carry the proof");
  assert.equal(retiredDowns().at(-1)!.outcome, "refused:fence_not_retired");
  assert.equal((await w.show(id)).state, "releasing");
  assert.equal(await w.used(), 2);
  // The refused proof is cleared and flagged, so the next teardown runs the normal armed path.
  assert.equal((await w.show(id)).fence_retired_proof, null);
  const refused = await w.flags("fence_retired_refused");
  assert.equal(refused.length, 1);
  assert.match(refused[0]!.detail, /still carries the fence label/);
  const downs = retiredDowns().length;
  await ticksUntil(w, () => false, 1);
  assert.equal(retiredDowns().length, downs, "a cleared proof was sent again");
  assert.equal(w.guard.calls.filter((c) => c.method === "down" && c.leaseId === id).at(-1)!.outcome, "incomplete:fence_disarmed");
  // Ops remove the label (and the policy), and a person records the proof again: the retired teardown
  // completes, and the digest hears of it.
  delete w.ns.labels[FENCE_LABEL];
  assert.equal((await w.cli(["lease", "fence-retired", id, "--proof", PROOF])).code, 0);
  await ticksUntil(w, () => false, 1);
  assert.equal(retiredDowns().at(-1)!.outcome, "complete");
  assert.equal((await w.show(id)).state, "released");
  assert.equal(await w.used(), 0);
  const flags = await w.flags("fence_retired_completion");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.lease_id, id);
  // The namespace, now unenrolled, cannot be claimed again.
  w.guard.setProbe(w.ns, ARMED);
  assert.equal((await w.claim(THREAD_B, w.ns, 1, { replaces: id })).json.code, "namespace_not_enrolled");
});

test("fence-retired refuses a lease that is not claimed", async () => {
  const w = await world();
  const { id } = await w.lease(THREAD_B, "dyntest-made-two", 1);
  await w.cli(["lease", "release", id], THREAD_B);
  assert.equal((await w.cli(["lease", "fence-retired", id, "--proof", PROOF])).json.code, "lease_not_claimed");
});

test("a proof recorded too early does not strand the lease: refused, it is cleared, and a re-armed fence completes", async () => {
  const w = await world();
  const id = (await w.claim(THREAD_A, w.ns, 2)).json.lease_id;
  w.guard.setProbe(w.ns, DISARMED);
  await w.cli(["lease", "release", id], THREAD_A);
  assert.equal((await w.cli(["lease", "fence-retired", id, "--proof", PROOF])).code, 0);
  // Ops re-arm instead of retiring.
  w.guard.setProbe(w.ns, ARMED);
  await ticksUntil(w, () => false, 1);
  assert.equal(w.guard.calls.filter((c) => c.method === "down" && c.leaseId === id).at(-1)!.outcome, "refused:fence_not_retired");
  assert.equal((await w.show(id)).fence_retired_proof, null);
  assert.equal((await w.flags("fence_retired_refused")).length, 1);
  await ticksUntil(w, () => false, 1);
  assert.equal((await w.show(id)).state, "released");
  assert.equal(await w.used(), 0);
  assert.equal((await w.flags("fence_retired_completion")).length, 0);
});

test("a refusal of an older proof never clears a newer one", () => {
  const { store, row } = closing();
  store.recordFenceRetired(row.id, PROOF);
  const newer = "https://example.test/incidents/fence-retired-2";
  store.recordFenceRetired(row.id, newer);
  assert.equal(store.fenceRetiredRefused(row.id, PROOF, "refused: still labelled"), false);
  assert.equal(store.find(row.id)!.fence_retired_proof, newer);
  assert.equal(store.fenceRetiredRefused(row.id, newer, "refused: still labelled"), true);
  assert.equal(store.find(row.id)!.fence_retired_proof, null);
  assert.equal(store.flags().filter((f) => f.kind === "fence_retired_refused").length, 1);
});

// --- a trial lease ---

test("armed: trial completes only a trial lease, under the same gate, seq and drain conditions", () => {
  const { store, cfg, ask } = storeWorld();
  const trial = store.claim({ ...ask, gpus: 1, trial: true, id: "lse_trialstore01", request: "req_trialstore001", replaces: null }, cfg, 10 * MIN).row;
  store.release(trial.id, THREAD_A, cfg);
  const report = (row: { id: string; claim_seq: number | null }): FenceReport => ({ fence: { lease_id: row.id, seq: row.claim_seq!, state: "closing" }, drain_monotonic_seconds: 120, max_probe_gap_seconds: 5, armed: "trial", lease_fence: "true" });
  const complete = (row: { id: string; uid: string }, r: FenceReport) => store.completeClaimed(row.id, row.uid, store.find(row.id)!.attempt_epoch, [], r);
  assert.equal(complete(trial, { ...report(trial), drain_monotonic_seconds: 60 }).freed, 0, "a short drain");
  assert.equal(complete(trial, { ...report(trial), fence: { lease_id: trial.id, seq: 9, state: "closing" } }).freed, 0, "a wrong seq");
  assert.equal(complete(trial, { ...report(trial), max_probe_gap_seconds: 8.1 }).freed, 0, "a probe gap past the limit");
  const { max_probe_gap_seconds: _, ...noGap } = report(trial);
  assert.equal(complete(trial, noGap).freed, 0, "no probe gap");
  assert.deepEqual(complete(trial, report(trial)), { completed: true, freed: 1 });
  // A lease that is not a trial frees nothing on a trial report.
  const normal = store.claim({ ...ask, id: "lse_normalstore1", request: "req_normalstore01", replaces: trial.id }, cfg, 10 * MIN).row;
  store.release(normal.id, THREAD_A, cfg);
  const refused = complete(normal, report(normal));
  assert.deepEqual([refused.completed, refused.freed], [false, 0]);
  assert.match(refused.why!, /trial/);
  assert.equal(complete(normal, { ...report(normal), armed: "continuous" }).freed, 2);
});

test("a trial lease: the live probe does not flag Audit with a fine-grained webhook, flags anything else, and its teardown completes as a trial", async () => {
  const w = await world({ fence: AUDIT });
  const id = (await w.claim(THREAD_A, w.ns, 1, { trial: true })).json.lease_id;
  await ticksUntil(w, () => false, 5);
  assert.equal(w.probes(), 2, "the fifth tick probed");
  assert.equal((await w.flags("fence_disarmed_live")).length, 0, "a trial under Audit is as expected");
  // The trial teardown completes, as a trial.
  assert.equal((await w.cli(["lease", "release", id], THREAD_A)).json.state, "released");
  assert.equal(await w.used(), 0);
  assert.equal((await w.flags("fence_disarmed")).length, 0);
});

test("a trial lease whose fence disarms is still flagged by the live probe", async () => {
  const w = await world({ fence: AUDIT });
  const id = (await w.claim(THREAD_A, w.ns, 1, { trial: true })).json.lease_id;
  w.guard.setProbe(w.ns, DISARMED);
  await ticksUntil(w, () => false, 5);
  const flags = await w.flags("fence_disarmed_live");
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.lease_id, id);
  assert.ok(flags[0]!.detail.includes(SCALED_TO_ZERO), flags[0]!.detail);
});
