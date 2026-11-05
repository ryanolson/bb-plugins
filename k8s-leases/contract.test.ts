// The contract test: the plugin against the real k8s-guard.
//
// The real guard runs through the real host entry, on the guard's own fake
// kubectl, bot kubeconfig, profiles and runner (contract/world.py builds them
// from the guard's test fixtures). The guard's `bb k8s lease ...` calls reach
// this plugin, running on bb's fake host, through a `bb` shim on PATH. No real
// cluster and no real bb server are touched.
//
// Run with the guard repository checked out at the pinned commit:
//   K8S_GUARD_REPO=/path/to/dynamo-dotfiles npm run test:contract
// Without K8S_GUARD_REPO every test here is skipped.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createHostEntry } from "./host.ts";
import { createK8sLeasesPlugin } from "./server.ts";

/** The k8s-guard commit this contract was last checked against: ryanolson/dynamo-dotfiles PR #17, branch k8s-guard. */
export const GUARD_COMMIT = "d92ec1a1fa27f33bdca1d878a0c2491799150867";

const REPO = process.env.K8S_GUARD_REPO;
const skip = REPO === undefined ? "K8S_GUARD_REPO is not set" : false;
const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const HOSTS = ["host_one", "host_two"];

interface World {
  dir: string;
  env: Record<string, string>;
  bin: string;
  guard: string;
  kubeconfig: string;
  check: string;
  ctx: string;
  profile: string;
  prefix: string;
  me: string;
}

let world: World;
let server: Server;
let cli: ((argv: string[], threadId: string | null) => Promise<{ exitCode: number; stdout: string; stderr: string }>) | null = null;
const savedEnv = { ...process.env };

function py(command: string, args: unknown = {}): string {
  return execFileSync("python3", ["-I", join(HERE, "contract/world.py"), REPO!, world.dir, command, JSON.stringify(args)], { encoding: "utf8" });
}
const state = () => JSON.parse(py("state")) as { namespaces: Record<string, any>; objects: Record<string, Record<string, any>>; pods: Record<string, any[]> };

before(async () => {
  if (skip) return;
  const head = execFileSync("git", ["-C", REPO!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, GUARD_COMMIT, `the guard repository is at ${head}, not the pinned ${GUARD_COMMIT}: check the contract again, then move the pin`);
  const dir = mkdtempSync(join(tmpdir(), "k8s-leases-contract-"));
  world = { dir, ...JSON.parse(execFileSync("python3", ["-I", join(HERE, "contract/world.py"), REPO!, dir, "init"], { encoding: "utf8" })) };
  writeFileSync(join(world.bin, "bb"), `#!${process.execPath}\n${readFileSync(join(HERE, "contract/bb-shim.mjs"), "utf8").replace(/^#!.*\n/, "")}`);
  chmodSync(join(world.bin, "bb"), 0o755);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const { argv, threadId } = JSON.parse(body) as { argv: string[]; threadId: string | null };
      const result =
        argv[0] !== "k8s" || cli === null ? { exitCode: 1, stdout: "", stderr: `not a k8s command: ${argv.join(" ")}` } : await cli(argv.slice(1), threadId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  // The host entry runs the guard with this process's environment, as a daemon would with its own.
  for (const key of Object.keys(process.env)) if (key.startsWith("BB_")) delete process.env[key];
  Object.assign(process.env, world.env, { PATH: `${world.bin}:/usr/bin:/bin`, CONTRACT_BB_PORT: String(port) });
});

after(async () => {
  if (skip) return;
  server?.close();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (world?.dir.startsWith(join(tmpdir(), "k8s-leases-contract-"))) rmSync(world.dir, { recursive: true, force: true });
});

/** The plugin on bb's fake host, with its host entry running the real guard on both hosts. */
async function plugin(options: { hostCall?: (method: string, input: any, hostId: string, real: () => Promise<unknown>) => Promise<unknown> } = {}) {
  let t = Math.floor(Date.now() / 1000) * 1000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const host = experimental_createHostEntryHarness(createHostEntry());
  const { bb, harness } = createFakePluginHost({
    pluginId: "k8s-leases",
    settings: {
      hosts: JSON.stringify(HOSTS),
      guardCommand: world.guard,
      kubeconfig: world.kubeconfig,
      bbServerUrl: "http://127.0.0.1:1",
      profilesCommand: world.check,
      firstRunApprovals: JSON.stringify({ [world.profile]: "contract test" }),
    },
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId } as never) } as never },
    experimental_callHostRpc: ({ method, input, hostId }) => {
      const real = () => host.experimental_call(method as never, input as never);
      return options.hostCall ? options.hostCall(method, input, hostId, real) : real();
    },
  });
  await createK8sLeasesPlugin({ now: clock.now, tickWaitMs: 60_000 })(bb);
  cli = async (argv, threadId) => harness.behavior.runCli(argv, threadId === null ? {} : { threadId });
  const show = async (id: string) => JSON.parse((await harness.behavior.runCli(["lease", "show", id])).stdout);
  const tick = () => harness.behavior.runSchedule("reconcile");
  return { bb, harness, host, clock, show, tick };
}

/**
 * Run the real guard as the agent of thread `thread`, as an agent runs it.
 * Asynchronous: the guard's `bb` calls come back into this process.
 */
/** Each thread's storage, where its guard ledger lives. */
const storageOf = (thread: string) => join(world.dir, `storage-${thread}`);

function agentGuard(thread: string, ...args: string[]): Promise<{ code: number; json: any }> {
  const storage = storageOf(thread);
  return new Promise((resolve) => {
    const child = execFile(
      world.guard,
      args,
      { env: { ...process.env, BB_THREAD_ID: thread, BB_THREAD_STORAGE: storage, KUBECONFIG: world.kubeconfig }, encoding: "utf8", timeout: 60_000 },
      (error, stdout) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, json: JSON.parse(stdout || "{}") }),
    );
    child.stdin?.end();
  });
}

/** The length of the random suffix `k8s-guard ns create` gives every namespace name (Ryan, F14). */
const SUFFIX_LENGTH = 10;

/** A never-reused name, as `k8s-guard ns create` makes: <prefix><issue>-<purpose>-<suffix>. */
const fresh = (purpose: string) => `${world.prefix}12-${purpose}-${randomUUID().replace(/-/g, "").slice(0, SUFFIX_LENGTH)}`;

/**
 * A namespace as `k8s-guard ns create` leaves it, with a UUID as a real
 * cluster gives and the line it writes in the thread's ledger, and a lease
 * taken on it through the guard.
 */
async function leased(p: Awaited<ReturnType<typeof plugin>>, purpose: string, gpus = 4) {
  const ns = fresh(purpose);
  const uid = randomUUID();
  py("add-ns", { name: ns, thread: world.me, uid, ledger: join(storageOf(world.me), "k8s-ledger.jsonl") });
  const got = await agentGuard(world.me, "--context", world.ctx, "-n", ns, "lease", "acquire", "--gpus", String(gpus), "--hours", "1");
  assert.equal(got.code, 0, `k8s-guard lease acquire: ${JSON.stringify(got.json)}`);
  return { ns, uid, id: got.json.lease_id as string };
}

const writesTo = (ns: string) =>
  readFileSync(join(world.dir, "kubectl.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((c) => ["create", "apply", "patch", "replace", "delete"].includes(c.pos?.[0]) && JSON.stringify(c).includes(ns));

test("acquire through the real guard: the lease holds the profile name, the kube context and the namespace UID", { skip }, async () => {
  const p = await plugin();
  await p.tick();
  const { id, ns, uid } = await leased(p, "cacquire");
  const lease = await p.show(id);
  assert.deepEqual([lease.state, lease.cluster, lease.context, lease.namespace, lease.uid], ["active", world.profile, world.ctx, ns, uid]);
  assert.equal(state().objects[ns]!["ConfigMap/wcep-agent-lease"]!.data.lease_id, id);
  await p.harness.lifecycle.dispose();
});

test("expiry: the real guard scales the DGDs to 0 on the plugin's word, then deletes after the grace period", { skip }, async () => {
  const p = await plugin();
  await p.tick();
  const { id, ns } = await leased(p, "cexpire");
  py("add-dgd", { ns, name: "worker", gpus: 4, lease: id });
  p.clock.advance(HOUR + MIN);
  await p.tick();
  assert.equal((await p.show(id)).state, "revoking");
  const dgd = state().objects[ns]!["DynamoGraphDeployment/worker"]!;
  assert.ok(dgd.spec.components.every((c: { replicas: number }) => c.replicas === 0), JSON.stringify(dgd.spec.components));
  // The pods go, then the grace period ends.
  const st = state();
  st.pods[ns] = [];
  py("set", st);
  p.clock.advance(HOUR);
  await p.tick();
  assert.equal(state().namespaces[ns], undefined, "the namespace was not deleted after the grace period");
  await p.tick();
  assert.equal((await p.show(id)).state, "torn-down");
  await p.harness.lifecycle.dispose();
});

test("a namespace re-created under the same name: the real guard refuses every teardown write, and the new namespace is untouched", { skip }, async () => {
  const p = await plugin();
  await p.tick();
  const { id, ns } = await leased(p, "crecreate");
  py("add-dgd", { ns, name: "worker", gpus: 4, lease: id });
  assert.equal(JSON.parse((await p.harness.behavior.runCli(["lease", "release", id], { threadId: world.me })).stdout).state !== undefined, true);
  // Whatever the release did, the namespace is now gone and made again with a new UID.
  const st = state();
  delete st.namespaces[ns];
  st.objects[ns] = {};
  st.pods[ns] = [];
  py("set", st);
  py("add-ns", { name: ns, thread: world.me, uid: randomUUID() });
  py("add-dgd", { ns, name: "other", gpus: 2, lease: "lse_other0000001", uid: "uid-other-dgd" });
  const before = writesTo(ns).length;
  await p.tick();
  await p.tick();
  assert.equal((await p.show(id)).state, "released");
  assert.deepEqual(writesTo(ns).slice(before), [], "a write reached the re-created namespace");
  assert.equal(state().objects[ns]!["DynamoGraphDeployment/other"]!.spec.components[1].replicas, 1);
  await p.harness.lifecycle.dispose();
});

test("a deletion whose response is lost, then the namespace re-created: the new namespace is untouched", { skip }, async () => {
  let lose = true;
  const p = await plugin({
    hostCall: async (method, _input, _hostId, real) => {
      const result = await real();
      if (method === "down" && lose) {
        lose = false;
        throw new Error("the response was lost");
      }
      return result;
    },
  });
  await p.tick();
  const { id, ns } = await leased(p, "clost");
  await p.harness.behavior.runCli(["lease", "release", id], { threadId: world.me });
  if (state().namespaces[ns] !== undefined) {
    // The guard keeps the namespace until its GPU pods are gone; let them go and tick again.
    await p.tick();
  }
  py("add-ns", { name: ns, thread: world.me, uid: randomUUID() });
  py("add-dgd", { ns, name: "other", gpus: 2, lease: "lse_other0000002", uid: "uid-other-dgd2" });
  const before = writesTo(ns).length;
  await p.tick();
  await p.tick();
  assert.equal((await p.show(id)).state, "released");
  assert.deepEqual(writesTo(ns).slice(before), []);
  await p.harness.lifecycle.dispose();
});

test("a host that inspects the wrong namespace cannot free the lease's GPUs", { skip }, async () => {
  let misroute = false;
  const decoy = fresh("cdecoy");
  const p = await plugin({
    hostCall: (method, input, hostId, real) =>
      misroute && method === "inspect" && hostId === "host_one" && input.namespace.includes("-cmisroute-")
        ? (p.host.experimental_call("inspect", { ...input, namespace: decoy }) as Promise<unknown>)
        : real(),
  });
  await p.tick();
  py("add-ns", { name: decoy, thread: world.me, uid: randomUUID() });
  const { id } = await leased(p, "cmisroute");
  misroute = true; // from here on, host one answers for the decoy namespace
  for (let n = 0; n < 3; n += 1) await p.tick();
  assert.equal((await p.show(id)).state, "active");
  await p.harness.lifecycle.dispose();
});

test("an inspect answer with an empty UID frees nothing", { skip }, async () => {
  const p = await plugin();
  await p.tick();
  const { id, ns } = await leased(p, "cemptyuid");
  const st = state();
  st.namespaces[ns].metadata.uid = "";
  py("set", st);
  for (let n = 0; n < 2; n += 1) await p.tick();
  assert.equal((await p.show(id)).state, "active");
  await p.harness.lifecycle.dispose();
});

test("p3 f3 on the real guard: an extend that lands late cannot pull the expiry back", { skip }, async () => {
  const p = await plugin();
  await p.tick();
  const { id, ns } = await leased(p, "cextend");
  await p.tick(); // expires-at in step with the lease
  // A: the panel extends by 30 min; its guard call is held just before its write.
  writeFileSync(join(world.dir, "hold-replace"), "");
  const first = p.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 });
  for (let n = 0; n < 200 && !existsSync(join(world.dir, "held")); n += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(world.dir, "held")), "the first extend never reached its write");
  // B: another 30 min. The plugin commits it at once; its own sync waits behind A,
  // so a second guard run writes it while A is held.
  const second = p.harness.behavior.callRpc("extend", { leaseId: id, minutes: 30 });
  await new Promise((r) => setTimeout(r, 100));
  const lease = await p.show(id);
  const direct = await p.host.experimental_call("extend", {
    run: { command: world.guard, serverUrl: "http://127.0.0.1:1", kubeconfig: world.kubeconfig },
    context: world.ctx,
    namespace: ns,
    uid: lease.uid,
    leaseId: id,
  });
  assert.deepEqual(direct, { ok: true });
  assert.equal(state().objects[ns]!["ConfigMap/wcep-agent-lease"]!.data.expires_at, lease.expires_at);
  // A lands late, on the record as it read it.
  writeFileSync(join(world.dir, "release-replace"), "");
  await Promise.allSettled([first, second]);
  assert.equal(state().objects[ns]!["ConfigMap/wcep-agent-lease"]!.data.expires_at, lease.expires_at, "the late extend pulled the expiry back");
  rmSync(join(world.dir, "hold-replace"));
  await p.harness.lifecycle.dispose();
});
