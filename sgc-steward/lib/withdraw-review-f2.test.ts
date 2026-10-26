import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";

test("withdraw review F2: a temporary thread lookup failure keeps the notice retryable", async (t) => {
  const { harness, linear, sends, factory } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  const asked = await harness.behavior.runCli(["ask", "--question", "Still waiting?", "--issue", issue.identifier, "--json"], { threadId: "thr_asker" });
  assert.equal(asked.exitCode, 0, asked.stderr);
  const { id } = JSON.parse(asked.stdout) as { id: string };
  let lookups = 0;
  harness.inspection.sdk.stub("threads.get", async () => {
    lookups += 1;
    throw new Error("temporary SDK timeout");
  });

  // The steward withdraws through its agent tool; the CLI grants no steward power (review F1).
  const result = await harness.behavior.callAgentTool("sgc_withdraw_question", { id, reason: "Decided elsewhere." }, { threadId: "thr_steward" });
  assert.equal(typeof result, "string", JSON.stringify(result));
  assert.equal(lookups, 1);
  assert.match(result as string, /Recorded it on TEAM-1\./);
  assert.equal(issue.comments.length, 1, "the withdrawal record lands");

  harness.inspection.sdk.stub("threads.get", async () => ({
    id: "thr_asker", title: "Asker", environmentId: null, archivedAt: null, deletedAt: null,
  }));
  const repeated = await harness.behavior.callAgentTool("sgc_withdraw_question", { id, reason: "Decided elsewhere." }, { threadId: "thr_steward" });
  assert.equal(typeof repeated === "string" ? false : repeated.isError, true, "the committed withdrawal cannot be repeated");
  assert.match(JSON.stringify(repeated), /not open/);

  // Recovery must retain the notice after the SDK outage has ended.
  const replacement = await harness.lifecycle.reload(factory);
  t.after(() => replacement.harness.lifecycle.dispose());
  const after = await replacement.harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual({ open: after.asks.length, notices: sends.length + after.undelivered.length, records: issue.comments.length },
    { open: 0, notices: 1, records: 1 },
    "an unknown thread lookup result must not permanently discard the withdrawal notice");
});
