import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";

test("withdraw review F2: a temporary thread lookup failure keeps the notice retryable", {
  skip: "F2: liveThread treats every lookup error as a missing thread and saves no notice",
}, async (t) => {
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

  const result = await harness.behavior.runCli(["withdraw", id, "--reason", "Decided elsewhere.", "--json"], { threadId: "thr_steward" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(lookups, 1);
  assert.equal(JSON.parse(result.stdout).record, "posted");
  assert.equal(issue.comments.length, 1, "the withdrawal record lands");

  harness.inspection.sdk.stub("threads.get", async () => ({
    id: "thr_asker", title: "Asker", environmentId: null, archivedAt: null, deletedAt: null,
  }));
  const repeated = await harness.behavior.runCli(["withdraw", id, "--reason", "Decided elsewhere."], { threadId: "thr_steward" });
  assert.equal(repeated.exitCode, 1, "the committed withdrawal cannot be repeated");
  assert.match(repeated.stderr, /not open/);

  // Recovery must retain the notice after the SDK outage has ended.
  const replacement = await harness.lifecycle.reload(factory);
  t.after(() => replacement.harness.lifecycle.dispose());
  const after = await replacement.harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual({ open: after.asks.length, notices: sends.length + after.undelivered.length, records: issue.comments.length },
    { open: 0, notices: 1, records: 1 },
    "an unknown thread lookup result must not permanently discard the withdrawal notice");
});
