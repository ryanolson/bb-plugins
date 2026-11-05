import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { HostsView } from "./hosts.ts";
import { setup } from "../test-support.ts";
import { HOSTS, IDLE, LIMITS_JSON, NOW, QUEUE, RUNNING, THREADS } from "../test-support-hosts.ts";

type MountedHosts = { view: HostsView | null; error: string | null; load: () => void };
type Effect = () => void | (() => void);

function mountHosts(call: (method: string, args: unknown) => Promise<HostsView>) {
  const source = ts.createSourceFile("app.tsx", readFileSync(new URL("../app.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["errorText", "HOSTS_REFRESH_MS", "useHosts"]);
  // Load the private hook from source so this review changes only tests.
  const declarations = source.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement)
      ? statement.name !== undefined && names.has(statement.name.text)
      : ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => names.has(declaration.name.getText(source))),
  );
  assert.equal(declarations.length, 3);
  const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const state: unknown[] = [];
  const effects: Effect[] = [];
  const rpc = { call };
  const useHosts = runInNewContext(`${code}\nuseHosts;`, {
    useRpc: () => rpc,
    useState: (initial: unknown) => {
      const index = state.length;
      state.push(initial);
      return [initial, (next: unknown) => { state[index] = next; }];
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: Effect) => { effects.push(effect); },
    setInterval: () => 1,
    clearInterval: () => {},
  }) as (active: boolean) => MountedHosts;
  const mounted = useHosts(true);
  const cleanups = effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
  return { mounted, view: () => state[0] as HostsView | null, dispose: () => cleanups.forEach((cleanup) => cleanup()) };
}

test("hosts review F2: an earlier read cannot replace a newer completed refresh", async (t) => {
  let now = NOW;
  let waiting = false;
  const pendingLimits: Array<(json: string) => void> = [];
  const { harness } = await setup({
    key: null,
    now: () => now,
    runBb: () => new Promise<string>((resolve) => { pendingLimits.push(resolve); }),
  });
  t.after(() => harness.lifecycle.dispose());
  const sdk = harness.inspection.sdk;
  sdk.stub("hosts.list", async () => HOSTS.map((host) => ({ ...host })));
  sdk.stub("threads.listRunning", async () => RUNNING.map((thread) => ({ ...thread })));
  sdk.stub("threads.count", async () => structuredClone(IDLE));
  sdk.stub("threads.queue.list", async () => waiting ? structuredClone(QUEUE) : []);
  sdk.stub("threads.list", async (args: unknown) => {
    const { threadIds } = args as { threadIds: string[] };
    return THREADS.filter((thread) => threadIds.includes(thread.id)).map((thread) => ({ ...thread }));
  });
  const hook = mountHosts(async (method, args) => {
    assert.equal(method, "hosts.list");
    assert.equal(args, null);
    return await harness.behavior.callRpc("hosts.list", null) as HostsView;
  });
  t.after(hook.dispose);
  await nextTurn();
  assert.ok(pendingLimits.length > 0);
  for (const resolve of pendingLimits.splice(0)) resolve(LIMITS_JSON);
  await nextTurn();
  assert.equal(hook.view()?.checkedAt, NOW, "the control: a completed read updates the mounted hook");
  assert.equal(hook.view()?.hosts.find((host) => host.id === "host_wait")?.waiting, 0);

  hook.mounted.load();
  await nextTurn();
  waiting = true;
  now = NOW + 1_000;
  hook.mounted.load();
  await nextTurn();
  assert.equal(pendingLimits.length, 2);
  pendingLimits[1]!(LIMITS_JSON);
  await nextTurn();
  const newer = hook.view();
  assert.equal(newer?.hosts.find((host) => host.id === "host_wait")?.waiting, 2);
  assert.equal(newer?.checkedAt, NOW + 1_000);

  now = NOW + 2_000;
  pendingLimits[0]!(LIMITS_JSON);
  await nextTurn();
  assert.equal(hook.view(), newer, "a slower limit-status read must not restore the earlier counts with zero waiting turns");
});
