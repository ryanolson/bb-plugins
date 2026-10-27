import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./lib/contract.ts";
import { LinearError } from "./lib/linear.ts";
import { QUESTIONS, rejection, setup } from "./test-support.ts";

type Harness = Awaited<ReturnType<typeof setup>>["harness"];
type Fake = Awaited<ReturnType<typeof setup>>["linear"];

const STEWARD = "thr_steward";
const ACTION = "waiting:ryan-action";

interface DoneResult {
  identifier: string;
  commentId: string;
  change: "state" | "label";
  steward: "sent" | "failed" | "skipped";
  undo: string;
}

const refresh = async (harness: Harness) => (await harness.behavior.callRpc("questions.refresh", null)) as Panel;
const done = async (harness: Harness, issue: string, note = "") => (await harness.behavior.callRpc("todos.done", { issue, note })) as DoneResult;

/** Todos of every kind on one team, and issues that are not todos. */
function seed(linear: Fake) {
  return {
    action: linear.addIssue("TEAM-1", [ACTION], "TEAM", { description: "Needs a token.\n\n- [ ] Make a token\n- [x] Pick the scopes" }),
    decision: linear.addIssue("TEAM-2", ["waiting:ryan-decision"]),
    others: linear.addIssue("TEAM-3", ["waiting:others"]),
    mine: linear.addIssue("TEAM-4", ["human"], "TEAM", { assignedToMe: true, state: { id: "state-started", type: "started" } }),
    theirs: linear.addIssue("TEAM-5", ["human"], "TEAM", { assignedToMe: false }),
    finished: linear.addIssue("TEAM-6", ["human"], "TEAM", { assignedToMe: true, state: { id: "state-done", type: "completed" } }),
    elsewhere: linear.addIssue("OTHER-1", [ACTION], "OTHER"),
  };
}

test("the todo list holds open issues waiting on the owner's action, and the owner's own human issues", async () => {
  const { harness, linear } = await setup();
  seed(linear);
  const panel = await refresh(harness);
  assert.deepEqual(panel.todos.map((todo) => [todo.identifier, todo.human]), [["TEAM-1", false], ["TEAM-4", true]]);
  assert.deepEqual(panel.todos[0]!.steps, [{ text: "Make a token", done: false }, { text: "Pick the scopes", done: true }]);
  assert.deepEqual(panel.todos[1]!.steps, [], "a description without task lines has no steps");
  assert.equal(panel.todos[0]!.url, "https://linear.example/TEAM-1");
  assert.equal(panel.todoError, null);
});

test("Done on a human issue posts the owner's comment, moves it to Done, and tells the steward once", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { mine } = seed(linear);
  await refresh(harness);
  const result = await done(harness, "TEAM-4", "Logged in on both machines.");
  assert.deepEqual([result.identifier, result.change, result.steward], ["TEAM-4", "state", "sent"]);
  assert.equal(mine.comments.length, 1);
  assert.equal(mine.comments[0]!.body, "Done (from the SGC page)\n\nLogged in on both machines.");
  assert.equal(mine.comments[0]!.id, result.commentId);
  assert.deepEqual(mine.state, { id: "state-done", type: "completed" });
  assert.deepEqual(mine.labels.map((label) => label.name), ["human"], "a human issue keeps its labels");
  assert.deepEqual(sends.map((send) => [send.threadId, send.mode, send.input[0]!.text]), [
    [STEWARD, "queue-if-active", "[sgc-steward] Todo done TEAM-4: Title of TEAM-4\nLogged in on both machines."],
  ]);
  assert.deepEqual((await harness.behavior.callRpc("questions.list", null) as Panel).todos.map((todo) => todo.identifier), ["TEAM-1"]);
});

test("Done on another issue removes only the todo label, leaves the state, and tells the steward", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { action } = seed(linear);
  action.labels.push({ id: "label-area", name: "area" });
  const result = await done(harness, "TEAM-1");
  assert.deepEqual([result.change, result.steward], ["label", "sent"]);
  assert.deepEqual(action.labels.map((label) => label.name), ["area"]);
  assert.deepEqual(action.state, { id: "state-started", type: "started" }, "the agent work behind it continues");
  assert.deepEqual(action.comments.map((comment) => comment.body), ["Done (from the SGC page)"]);
  assert.deepEqual(sends.map((send) => send.input[0]!.text), ["[sgc-steward] Todo done TEAM-1: Title of TEAM-1"]);
});

test("with no steward thread, or one archived or gone, Done still changes Linear and sends nothing", async () => {
  for (const steward of ["unset", "archived", "gone"] as const) {
    const { harness, linear, sends } = await setup();
    if (steward !== "unset") await harness.behavior.setSettings({ stewardThread: STEWARD });
    harness.inspection.sdk.stub("threads.get", async (args: unknown) => {
      const { threadId } = args as { threadId: string };
      if (steward === "gone") throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404, code: "thread_not_found" });
      return { id: threadId, title: "Steward", titleFallback: null, environmentId: null, archivedAt: 1_800_000_000_000, deletedAt: null };
    });
    const { action } = seed(linear);
    const result = await done(harness, "TEAM-1");
    assert.equal(result.steward, "skipped", steward);
    assert.equal(action.comments.length, 1, steward);
    assert.deepEqual(action.labels, [], steward);
    assert.equal(sends.length, 0, steward);
    assert.deepEqual((await harness.behavior.callRpc("questions.list", null) as Panel).undelivered, [], steward);
  }
});

test("two Done clicks at once post one comment and send one message", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { action } = seed(linear);
  let reached!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const create = linear.createComment.bind(linear);
  let held = false;
  linear.createComment = async (args) => {
    if (!held) {
      held = true;
      reached();
      await gate;
    }
    return create(args);
  };
  const first = done(harness, "TEAM-1");
  await inside;
  const second = rejection(done(harness, "TEAM-1"));
  release();
  const [won, lost] = await Promise.all([first, second]);
  assert.equal(won.change, "label");
  assert.equal(lost.code, "conflict");
  assert.match(lost.message, /not on the todo list/);
  assert.equal(action.comments.length, 1);
  assert.equal(sends.length, 1);
});

test("each new todo is announced once across polls, and none when notify is off", async () => {
  const { harness, linear, claim } = await setup();
  linear.addIssue("TEAM-1", [ACTION]);
  await refresh(harness);
  assert.deepEqual((await claim()).notifications.map((note) => [note.source, note.label, note.preview]), [["todo", "TEAM-1", "Title of TEAM-1"]]);
  await refresh(harness);
  assert.deepEqual((await claim()).notifications, [], "a todo already announced is not announced again");
  linear.addIssue("TEAM-2", ["human"], "TEAM", { assignedToMe: true });
  await refresh(harness);
  assert.deepEqual((await claim()).notifications.map((note) => note.label), ["TEAM-2"]);
  await harness.behavior.setSettings({ notify: false });
  linear.addIssue("TEAM-3", [ACTION]);
  await refresh(harness);
  assert.deepEqual((await claim()).notifications, []);
});

test("Done on an issue with an open check-in block leaves the block open", async () => {
  const { harness, linear } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin", ACTION]);
  linear.post(issue, "q1", QUESTIONS);
  assert.deepEqual((await refresh(harness)).issues.flatMap((open) => open.blocks.map((block) => block.commentId)), ["q1"]);
  await done(harness, "TEAM-1", "Q1. A");
  const after = await refresh(harness);
  assert.deepEqual(after.issues.flatMap((open) => open.blocks.map((block) => block.commentId)), ["q1"], "Done is not an answer");
  assert.deepEqual(after.todos, []);
});

test("a steward message that fails to send is listed with a retry", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  seed(linear);
  harness.inspection.sdk.stub("threads.send", async () => {
    throw new Error("the bb server is busy");
  });
  const result = await done(harness, "TEAM-1");
  assert.equal(result.steward, "failed");
  const panel = (await harness.behavior.callRpc("questions.list", null)) as Panel;
  assert.deepEqual(panel.undelivered.map((row) => [row.source, row.label, row.threadId, row.error]), [["todo", "Todo done TEAM-1", STEWARD, "the bb server is busy"]]);
  const cli = await harness.behavior.runCli(["questions", "--cached"]);
  assert.match(cli.stdout, /Todo done TEAM-1 to thr_steward: the bb server is busy/);
  harness.inspection.sdk.stub("threads.send", async (args: unknown) => {
    sends.push(args as (typeof sends)[number]);
    return {};
  });
  assert.deepEqual(await harness.behavior.callRpc("deliveries.retry", { id: panel.undelivered[0]!.id }), { delivered: true, error: null });
  assert.deepEqual(sends.map((send) => send.input[0]!.text), ["[sgc-steward] Todo done TEAM-1: Title of TEAM-1"]);
});

test("a todo marked done by mistake is reopened once: the label or the state comes back, and the steward hears", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { action, mine } = seed(linear);
  await refresh(harness);
  const label = await done(harness, "TEAM-1");
  const state = await done(harness, "TEAM-4");
  for (const undo of [label.undo, state.undo]) {
    const reopened = (await harness.behavior.callRpc("todos.reopen", { undo })) as { identifier: string; steward: string };
    assert.equal(reopened.steward, "sent");
  }
  assert.deepEqual(action.labels.map((found) => found.name), [ACTION]);
  assert.deepEqual(mine.state, { id: "state-started", type: "started" });
  assert.deepEqual(action.comments.map((comment) => comment.body), ["Done (from the SGC page)", "Reopened (from the SGC page)"]);
  assert.deepEqual(sends.map((send) => send.input[0]!.text.split("\n")[0]), [
    "[sgc-steward] Todo done TEAM-1: Title of TEAM-1",
    "[sgc-steward] Todo done TEAM-4: Title of TEAM-4",
    "[sgc-steward] Todo reopened TEAM-1: Title of TEAM-1",
    "[sgc-steward] Todo reopened TEAM-4: Title of TEAM-4",
  ]);
  assert.deepEqual((await harness.behavior.callRpc("questions.list", null) as Panel).todos.map((todo) => todo.identifier), ["TEAM-1", "TEAM-4"]);
  const again = await rejection(harness.behavior.callRpc("todos.reopen", { undo: label.undo }));
  assert.equal(again.code, "not_found", "an undo works once");
  assert.equal(action.comments.length, 2);
});

test("Done refuses an issue that is not on the todo list, or not on the team", async () => {
  const { harness, linear } = await setup();
  const { decision } = seed(linear);
  const notTodo = await rejection(done(harness, "TEAM-2"));
  assert.equal(notTodo.code, "conflict");
  const otherTeam = await rejection(done(harness, "OTHER-1"));
  assert.equal(otherTeam.code, "invalid");
  const missing = await rejection(done(harness, "TEAM-404"));
  assert.equal(missing.code, "not_found");
  assert.equal(decision.comments.length, 0);
});

test("bb sgc todos lists the todos with their steps, and bb sgc todo done marks one done", async () => {
  const { harness, linear } = await setup();
  const { action } = seed(linear);
  const listed = await harness.behavior.runCli(["todos"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /^TEAM-1  Title of TEAM-1\n  https:\/\/linear\.example\/TEAM-1\n  \[ \] Make a token\n  \[x\] Pick the scopes\n/);
  assert.match(listed.stdout, /TEAM-4  Title of TEAM-4  \[human\]/);
  assert.match(listed.stdout, /Done: bb sgc todo done <issue> \[--note <text>\]/);
  const json = await harness.behavior.runCli(["todos", "--cached", "--json"]);
  assert.deepEqual((JSON.parse(json.stdout) as { todos: Array<{ identifier: string }> }).todos.map((todo) => todo.identifier), ["TEAM-1", "TEAM-4"]);
  const marked = await harness.behavior.runCli(["todo", "done", "TEAM-1", "--note", "Made it."]);
  assert.equal(marked.exitCode, 0, marked.stderr);
  assert.match(marked.stdout, /^Marked TEAM-1 done: removed the waiting:ryan-action label\./);
  assert.deepEqual(action.comments.map((comment) => comment.body), ["Done (from the SGC page)\n\nMade it."]);
  const twice = await harness.behavior.runCli(["todo", "done", "TEAM-1"]);
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr, /not on the todo list/);
});

test("a todo read that fails is reported on its own, and the questions still poll", async () => {
  const { harness, linear } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  linear.listTodoIssues = async () => {
    throw new LinearError("graphql", "Linear refused the request: label filter");
  };
  const panel = await refresh(harness);
  assert.equal(panel.error, null);
  assert.deepEqual(panel.issues.map((open) => open.identifier), ["TEAM-1"]);
  assert.match(panel.todoError ?? "", /label filter/);
  const cli = await harness.behavior.runCli(["todos", "--cached"]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderr, /Could not read the todos: .*label filter/);
});
