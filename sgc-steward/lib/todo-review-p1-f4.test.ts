import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";


test("todo review F4: a restart after changing Linear preserves the steward update", async (t) => {
  const { harness, linear, sends, factory } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const issue = linear.addIssue("TEAM-1", ["waiting:ryan-action"]);
  let reached!: () => void;
  let release!: () => void;
  const committed = new Promise<void>((resolve) => { reached = resolve; });
  const reply = new Promise<void>((resolve) => { release = resolve; });
  const removeLabel = linear.removeLabel.bind(linear);
  linear.removeLabel = async (args) => {
    await removeLabel(args);
    reached();
    await reply;
  };

  const marking = harness.behavior.callRpc("todos.done", { issue: issue.id, note: "" }).catch(() => undefined);
  await committed;
  assert.equal(issue.comments.length, 1);
  assert.deepEqual(issue.labels, []);
  assert.equal(sends.length, 0);

  let replacement: Awaited<ReturnType<typeof harness.lifecycle.reload>>;
  try {
    replacement = await harness.lifecycle.reload(factory);
  } finally {
    release();
    await marking;
  }
  t.after(() => replacement.harness.lifecycle.dispose());
  const panel = await replacement.harness.behavior.callRpc("questions.refresh", null) as Panel;
  assert.deepEqual(panel.todos, [], "the completed todo no longer appears in a poll");
  assert.equal(sends.length + panel.undelivered.filter((row) => row.source === "todo").length, 1,
    "the steward message must remain sent or recoverable across a restart");
});
