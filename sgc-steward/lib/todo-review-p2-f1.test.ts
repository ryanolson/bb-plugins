import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearError } from "./linear.ts";
import { rejection, setup } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "P2 F1: a resumed Undo skips the cancellation guard" };

test("todo review P2 F1: retrying an unfinished Undo preserves a later cancellation", pending, async (t) => {
  const { harness, linear, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const issue = linear.addIssue("TEAM-1", ["human"], "TEAM", { assignedToMe: true });
  const { undo } = await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }) as { undo: string };
  const setState = linear.setState.bind(linear);
  let first = true;
  linear.setState = async (args) => {
    if (first) {
      first = false;
      throw new LinearError("network", "the Undo state write did not reach Linear");
    }
    await setState(args);
  };
  const failed = await rejection(harness.behavior.callRpc("todos.reopen", { undo }));
  assert.match(failed.message, /Press Undo again/);
  assert.equal(issue.comments.length, 2);
  assert.equal(issue.state?.type, "completed");
  assert.equal(sends.length, 1);

  issue.state = { id: "state-canceled", type: "canceled" };
  await harness.behavior.callRpc("todos.reopen", { undo }).catch(() => undefined);
  assert.deepEqual({ state: issue.state, comments: issue.comments.length, messages: sends.length },
    { state: { id: "state-canceled", type: "canceled" }, comments: 2, messages: 1 },
    "the pending Undo must check changes made after its first attempt");
});
