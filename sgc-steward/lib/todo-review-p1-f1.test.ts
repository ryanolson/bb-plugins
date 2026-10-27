import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { LinearError } from "./linear.ts";
import { setup } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "F1: Done cannot resume a partial write" };

for (const change of ["label", "state"] as const) {
  test(`todo review F1: retry a dropped ${change} write without a second Done comment`, pending, async (t) => {
    const { harness, linear, sends } = await setup();
    t.after(() => harness.lifecycle.dispose());
    await harness.behavior.setSettings({ stewardThread: "thr_steward" });
    const issue = linear.addIssue("TEAM-1", change === "label" ? ["waiting:ryan-action"] : ["human"], "TEAM", { assignedToMe: true });
    if (change === "label") linear.removeLabelFaults.push("dropped");
    else {
      const setState = linear.setState.bind(linear);
      let first = true;
      linear.setState = async (args) => {
        if (first) {
          first = false;
          throw new LinearError("network", "the state write did not reach Linear");
        }
        await setState(args);
      };
    }

    const first = await harness.behavior.runCli(["todo", "done", issue.identifier, "--note", "Finished."]);
    assert.equal(first.exitCode, 1);
    assert.equal(issue.comments.length, 1, "the comment lands before the failed write");
    assert.equal(issue.state?.type, "started");
    assert.equal(issue.labels.length, 1);
    assert.equal(sends.length, 0);

    const retried = await harness.behavior.runCli(["todo", "done", issue.identifier, "--note", "Finished."]);
    assert.equal(retried.exitCode, 0, retried.stderr);
    assert.equal(change === "label" ? issue.labels.length : issue.state?.type, change === "label" ? 0 : "completed");
    assert.equal(sends.length, 1);
    assert.equal(issue.comments.length, 1, "resuming this Done must reuse its existing comment");
  });

  test(`todo review F1: a lost ${change} reply keeps the completed todo's steward update`, pending, async (t) => {
    const { harness, linear, sends } = await setup();
    t.after(() => harness.lifecycle.dispose());
    await harness.behavior.setSettings({ stewardThread: "thr_steward" });
    const issue = linear.addIssue("TEAM-1", change === "label" ? ["waiting:ryan-action"] : ["human"], "TEAM", { assignedToMe: true });
    if (change === "label") linear.removeLabelFaults.push("lost");
    else {
      const setState = linear.setState.bind(linear);
      linear.setState = async (args) => {
        await setState(args);
        throw new LinearError("network", "Linear committed the state but its reply was lost");
      };
    }

    await harness.behavior.runCli(["todo", "done", issue.identifier]);
    assert.equal(change === "label" ? issue.labels.length : issue.state?.type, change === "label" ? 0 : "completed");
    assert.equal(issue.comments.length, 1);
    const panel = await harness.behavior.callRpc("questions.refresh", null) as Panel;
    assert.deepEqual(panel.todos, [], "Linear has completed the todo");
    const retried = await harness.behavior.runCli(["todo", "done", issue.identifier]);
    assert.equal(issue.comments.length, 1, "a retry cannot perform a second completion");
    const after = await harness.behavior.callRpc("questions.list", null) as Panel;
    assert.equal(sends.length + after.undelivered.filter((row) => row.source === "todo").length, 1,
      `the steward update must be sent or recoverable after an ambiguous reply; retry exits ${retried.exitCode}`);
  });
}
