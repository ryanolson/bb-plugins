import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostsView } from "./hosts.ts";
import { LIMIT_STATUS_ARGS } from "./hosts-read.ts";
import { setup } from "../test-support.ts";
import { HOSTS, IDLE, LIMITS, LIMITS_JSON, NOW, RUNNING } from "../test-support-hosts.ts";

test("hosts review F1: unknown processor capacity keeps each host's effective limit", async (t) => {
  let status = LIMITS_JSON;
  const enrolled: Array<{ id: string; name: string; status: string }> = HOSTS.map((host) => ({ ...host }));
  const { harness } = await setup({
    key: null,
    now: () => NOW,
    runBb: async (args) => {
      assert.deepEqual(args, LIMIT_STATUS_ARGS);
      return status;
    },
  });
  t.after(() => harness.lifecycle.dispose());
  const sdk = harness.inspection.sdk;
  sdk.stub("hosts.list", async () => enrolled.map((host) => ({ ...host })));
  sdk.stub("threads.listRunning", async () => RUNNING.map((thread) => ({ ...thread })));
  sdk.stub("threads.count", async () => structuredClone(IDLE));
  sdk.stub("threads.queue.list", async () => []);

  const control = await harness.behavior.runCli(["hosts", "--json"]);
  assert.equal(control.exitCode, 0, control.stderr);
  assert.equal((JSON.parse(control.stdout) as HostsView).hosts.find((host) => host.id === "host_at")?.limit, 4);

  const unprobed = { id: "host_unprobed", name: "unprobed", status: "disconnected" };
  enrolled.push(unprobed);
  // bb returns null before its capacity detector reaches a host, with an automatic limit of one.
  status = JSON.stringify({
    ...LIMITS,
    hosts: [...LIMITS.hosts, { ...unprobed, availableParallelism: null, automaticLimit: 1, effectiveLimit: 1, override: null }],
  });

  const result = await harness.behavior.runCli(["hosts", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const view = JSON.parse(result.stdout) as HostsView;
  assert.equal(view.limitError, null);
  assert.equal(view.hosts.find((host) => host.id === "host_at")?.limit, 4);
  const unprobedRow = view.hosts.find((host) => host.id === unprobed.id)!;
  assert.deepEqual([unprobedRow.limit, unprobedRow.limitSource, unprobedRow.automaticLimit], [1, "automatic", 1]);
  assert.deepEqual(await harness.behavior.callRpc("hosts.list", null), view);
});
