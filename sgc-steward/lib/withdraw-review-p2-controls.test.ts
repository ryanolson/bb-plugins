import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";

function refused(result: PluginAgentToolResult): boolean {
  return typeof result !== "string" && result.isError === true;
}

test("withdraw pass 2: caller arguments cannot replace the session identity", async (t) => {
  const { harness, sends } = await setup({ key: null });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const asked = await harness.behavior.runCli(["ask", "--question", "Still open?", "--json"], { threadId: "thr_asker" });
  assert.equal(asked.exitCode, 0, asked.stderr);
  const { id } = JSON.parse(asked.stdout) as { id: string };
  for (const threadId of ["thr_other", "thr_fork", "thr_child"]) {
    const result = await harness.behavior.callAgentTool("sgc_withdraw_question", {
      id, reason: "Stale.", threadId: "thr_steward", caller: "thr_steward", steward: true,
    }, { threadId });
    assert.equal(refused(result), true, threadId);
  }
  const panel = await harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual(panel.asks.map((ask) => ask.id), [id]);
  assert.deepEqual(sends, []);
});

test("withdraw pass 2: transient lookup errors retain a failed notice for retry", async (t) => {
  for (const fault of [
    Object.assign(new Error("busy"), { status: 503, code: "service_unavailable" }),
    Object.assign(new Error("slow down"), { status: 429 }),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    new Error("temporary SDK timeout"),
  ]) {
    await t.test(fault.message, async (subtest) => {
      const { harness, sends } = await setup({ key: null });
      subtest.after(() => harness.lifecycle.dispose());
      await harness.behavior.setSettings({ stewardThread: "thr_steward" });
      const asked = await harness.behavior.runCli(["ask", "--question", "Keep the notice?", "--json"], { threadId: "thr_asker" });
      assert.equal(asked.exitCode, 0, asked.stderr);
      const { id } = JSON.parse(asked.stdout) as { id: string };
      harness.inspection.sdk.stub("threads.get", async () => { throw fault; });
      harness.inspection.sdk.stub("threads.send", async () => { throw new Error("send unavailable"); });
      const result = await harness.behavior.callAgentTool("sgc_withdraw_question", { id, reason: "Decided elsewhere." }, { threadId: "thr_steward" });
      assert.equal(refused(result), false);
      const panel = await harness.behavior.callRpc("questions.list", null) as Panel;
      assert.deepEqual({ open: panel.asks.length, notices: panel.undelivered.length }, { open: 0, notices: 1 });
      assert.equal(panel.undelivered[0]!.source, "withdrawal");
      harness.inspection.sdk.stub("threads.send", async (args: unknown) => { sends.push(args as (typeof sends)[number]); return {}; });
      assert.deepEqual(await harness.behavior.callRpc("deliveries.retry", { id: panel.undelivered[0]!.id }), { delivered: true, error: null });
      assert.equal(sends.length, 1);
    });
  }
});

test("withdraw pass 2: two steward calls save and send one notice and one record", async (t) => {
  const { harness, linear, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  const asked = await harness.behavior.runCli(["ask", "--question", "Which withdrawal wins?", "--issue", issue.identifier, "--json"], { threadId: "thr_asker" });
  assert.equal(asked.exitCode, 0, asked.stderr);
  const { id } = JSON.parse(asked.stdout) as { id: string };
  let release!: () => void;
  let bothReached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atChecks = new Promise<void>((resolve) => { bothReached = resolve; });
  let lookups = 0;
  harness.inspection.sdk.stub("threads.get", async () => {
    lookups += 1;
    if (lookups === 2) bothReached();
    await gate;
    return { id: "thr_asker", archivedAt: null, deletedAt: null };
  });
  const invoke = (reason: string) => harness.behavior.callAgentTool("sgc_withdraw_question", { id, reason }, { threadId: "thr_steward" });
  const calls = [invoke("First reason."), invoke("Second reason.")];
  try {
    await atChecks;
  } finally {
    release();
  }
  const results = await Promise.all(calls);
  assert.deepEqual(results.map(refused).sort(), [false, true]);
  assert.equal(sends.length, 1);
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0]!.body, /: withdrawn\n/);
  const panel = await harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual([panel.asks, panel.undelivered, panel.unposted], [[], [], []]);
});
