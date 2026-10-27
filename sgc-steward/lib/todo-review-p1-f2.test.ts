import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "F2: Undo does not check the configured team" };

for (const change of ["settings", "issue"] as const) {
  test(`todo review F2: Undo cannot write outside the configured team after ${change} change`, pending, async (t) => {
    const { harness, linear, sends } = await setup();
    t.after(() => harness.lifecycle.dispose());
    await harness.behavior.setSettings({ stewardThread: "thr_steward" });
    const issue = linear.addIssue("TEAM-1", ["waiting:ryan-action"]);
    const { undo } = await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }) as { undo: string };
    assert.equal(issue.comments.length, 1);
    assert.deepEqual(issue.labels, []);
    assert.equal(sends.length, 1);

    if (change === "settings") await harness.behavior.setSettings({ teamKey: "OTHER" });
    else {
      issue.teamKey = "OTHER";
      issue.identifier = "OTHER-1";
    }
    await harness.behavior.callRpc("todos.reopen", { undo }).catch(() => undefined);
    assert.deepEqual({ comments: issue.comments.length, labels: issue.labels, messages: sends.length },
      { comments: 1, labels: [], messages: 1 },
      "a token from a previously valid Done must not authorize writes outside the current team");
  });
}
