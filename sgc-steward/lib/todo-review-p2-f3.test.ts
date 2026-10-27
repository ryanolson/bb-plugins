import { test } from "node:test";
import assert from "node:assert/strict";
import { rejection, setup } from "../test-support.ts";


test("todo review P2 F3: changing the steward during a retry cannot duplicate its message", async (t) => {
  const { harness, linear, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_first" });
  const issue = linear.addIssue("TEAM-1", ["waiting:ryan-action"]);
  linear.removeLabelFaults.push("dropped");
  await rejection(harness.behavior.callRpc("todos.done", { issue: issue.id, note: "Finished." }));
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.labels.length, 1);
  assert.equal(sends.length, 0);

  await harness.behavior.setSettings({ stewardThread: "thr_second" });
  await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "Finished." });
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.comments.length, 1, "this is one completion with one comment");
  assert.equal(sends.length, 1,
    `one completion must send one steward message, not one to each retained recipient: ${sends.map((send) => send.threadId).join(", ")}`);
});
