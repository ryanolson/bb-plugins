import { test } from "node:test";
import assert from "node:assert/strict";
import type { TodoIssue } from "./linear.ts";
import { answeredBlocks } from "./questions.ts";
import { TODO_NOTE_CHARS, checkNote, checklist, doneComment, isTodo, reopenedComment, todoDoneMessage, todoReopenedMessage } from "./todos.ts";

function issue(extra: Partial<TodoIssue> = {}): TodoIssue {
  return {
    id: "uuid-1",
    identifier: "TEAM-1",
    title: "Log in on the build box",
    url: "https://linear.example/TEAM-1",
    description: "",
    teamKey: "TEAM",
    state: { id: "state-started", type: "started" },
    labels: [],
    assignedToMe: false,
    ...extra,
  };
}

const label = (name: string) => ({ id: `label-${name}`, name });

test("a todo is open and waits on the owner's action, or is the owner's own human issue", () => {
  assert.equal(isTodo(issue({ labels: [label("waiting:ryan-action")] })), true);
  assert.equal(isTodo(issue({ labels: [label("waiting:ryan-decision")] })), false, "a decision becomes a question, not a todo");
  assert.equal(isTodo(issue({ labels: [label("waiting:others")] })), false);
  assert.equal(isTodo(issue({ labels: [label("human")], assignedToMe: true })), true);
  assert.equal(isTodo(issue({ labels: [label("human")], assignedToMe: false })), false, "another person's human issue");
  assert.equal(isTodo(issue({ labels: [label("human")], assignedToMe: true, state: { id: "s", type: "completed" } })), false);
  assert.equal(isTodo(issue({ labels: [label("waiting:ryan-action")], state: { id: "s", type: "canceled" } })), false);
  assert.equal(isTodo(issue()), false);
});

test("checklist steps come from the description's task lines, done or not", () => {
  const description = [
    "Log in on the build box so the agents can run there.",
    "",
    "- [ ] `gh auth login`",
    "* [x] Claude Code",
    "  - [X] Codex  ",
    "- [] not a task line",
    "- plain bullet",
  ].join("\n");
  assert.deepEqual(checklist(description), [
    { text: "`gh auth login`", done: false },
    { text: "Claude Code", done: true },
    { text: "Codex", done: true },
  ]);
  assert.deepEqual(checklist("No steps here.\n- just a list"), []);
  assert.deepEqual(checklist(""), []);
});

test("a note is trimmed, an empty one is none, and a long one is refused", () => {
  assert.equal(checkNote("  Logged in on both.\n"), "Logged in on both.");
  assert.equal(checkNote(" \n "), null);
  assert.throws(() => checkNote("x".repeat(TODO_NOTE_CHARS + 1)), /the note is over 2000 characters/);
});

test("the done and reopened comments start with their markers, and answer no question block", () => {
  assert.equal(doneComment(null), "Done (from the SGC page)");
  assert.equal(doneComment("Logged in on both."), "Done (from the SGC page)\n\nLogged in on both.");
  assert.equal(reopenedComment(), "Reopened (from the SGC page)");
  for (const body of [doneComment(null), doneComment("Q1. A"), reopenedComment()]) assert.deepEqual(answeredBlocks(body), [], body);
});

test("the steward's message names the issue and its title, with the note on its own line", () => {
  assert.equal(todoDoneMessage("TEAM-1", "Log in on the build box", null), "[sgc-steward] Todo done TEAM-1: Log in on the build box");
  assert.equal(todoDoneMessage("TEAM-1", "Log in on the build box", "Logged in on both."), "[sgc-steward] Todo done TEAM-1: Log in on the build box\nLogged in on both.");
  assert.equal(todoReopenedMessage("TEAM-1", "Log in on the build box"), "[sgc-steward] Todo reopened TEAM-1: Log in on the build box");
});
