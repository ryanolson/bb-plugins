import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "F3: Undo does not detect a later cancellation" };

for (const change of ["label", "state"] as const) {
  test(`todo review F3: Undo of a ${change} change must preserve a later cancellation`, pending, async (t) => {
    const { harness, linear, sends } = await setup();
    t.after(() => harness.lifecycle.dispose());
    await harness.behavior.setSettings({ stewardThread: "thr_steward" });
    const issue = linear.addIssue("TEAM-1", change === "label" ? ["waiting:ryan-action"] : ["human"], "TEAM", { assignedToMe: true });
    const { undo } = await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }) as { undo: string };
    assert.equal(change === "label" ? issue.labels.length : issue.state?.type, change === "label" ? 0 : "completed");
    assert.equal(issue.comments.length, 1);
    assert.equal(sends.length, 1);

    issue.state = { id: "state-canceled", type: "canceled" };
    const labels = structuredClone(issue.labels);
    await harness.behavior.callRpc("todos.reopen", { undo }).catch(() => undefined);
    assert.deepEqual({ state: issue.state, labels: issue.labels, comments: issue.comments.length, messages: sends.length },
      { state: { id: "state-canceled", type: "canceled" }, labels, comments: 1, messages: 1 },
      "Undo may reverse its own Done, but must not undo somebody else's later cancellation");
  });
}
