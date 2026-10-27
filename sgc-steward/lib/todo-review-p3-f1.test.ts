import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../test-support.ts";


test("todo review P3 F1: a newer Done invalidates an older Undo for the same issue", async (t) => {
  const { harness, linear, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  linear.states.push({ id: "state-review", name: "In Review", type: "started" });
  const issue = linear.addIssue("TEAM-1", ["human"], "TEAM", { assignedToMe: true });
  const done = async () => await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }) as { undo: string };
  const first = await done();

  issue.state = { id: "state-review", type: "started" };
  const second = await done();
  assert.notEqual(first.undo, second.undo);
  await harness.behavior.callRpc("todos.reopen", { undo: second.undo });
  assert.deepEqual(issue.state, { id: "state-review", type: "started" }, "the latest Undo restores the correct active state");
  await done();
  assert.deepEqual(issue.state, { id: "state-done", type: "completed" });
  const comments = issue.comments.length;
  const messages = sends.length;

  await harness.behavior.callRpc("todos.reopen", { undo: first.undo }).catch(() => undefined);
  assert.deepEqual({ state: issue.state, comments: issue.comments.length, messages: sends.length },
    { state: { id: "state-done", type: "completed" }, comments, messages },
    "an earlier completion's token must not overwrite a newer completion with its stale restore state");
});
