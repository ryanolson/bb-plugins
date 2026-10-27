import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearError } from "./linear.ts";
import { rejection, setup } from "../test-support.ts";


test("todo review P2 F4: a recovered Undo is announced before the next Done", async (t) => {
  const { harness, linear, sends } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const issue = linear.addIssue("TEAM-1", ["waiting:ryan-action"]);
  const { undo } = await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }) as { undo: string };
  const addLabel = linear.addLabel.bind(linear);
  linear.addLabel = async () => { throw new LinearError("network", "the Undo label write did not reach Linear"); };
  await rejection(harness.behavior.callRpc("todos.reopen", { undo }));
  assert.deepEqual(issue.labels, []);
  assert.equal(sends.length, 1);

  await addLabel({ issueId: issue.id, labelId: "label-waiting:ryan-action" });
  await harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" });
  assert.deepEqual(issue.labels, [], "the final state is done");
  assert.equal(issue.comments.length, 3, "the first Done, the failed Undo, and the next Done each have one comment");
  assert.deepEqual(sends.map((send) => send.input[0]!.text), [
    "[sgc-steward] Todo done TEAM-1: Title of TEAM-1",
    "[sgc-steward] Todo reopened TEAM-1: Title of TEAM-1",
    "[sgc-steward] Todo done TEAM-1: Title of TEAM-1",
  ], "the steward must hear the recovery before the newer action that supersedes it");
});
