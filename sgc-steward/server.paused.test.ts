import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./lib/contract.ts";
import { rejection, setup } from "./test-support.ts";

type Harness = Awaited<ReturnType<typeof setup>>["harness"];
type Fake = Awaited<ReturnType<typeof setup>>["linear"];

const STEWARD = "thr_steward";
const BACKLOG = { id: "state-backlog", type: "backlog" };

interface ResumeResult {
  identifier: string;
  commentId: string;
  steward: "sent" | "failed" | "skipped";
  resumed: boolean;
}

const refresh = async (harness: Harness) => (await harness.behavior.callRpc("questions.refresh", null)) as Panel;
const resume = async (harness: Harness, issue: string, note = "") => (await harness.behavior.callRpc("paused.resume", { issue, note })) as ResumeResult;

function seed(linear: Fake) {
  return {
    older: linear.addIssue("TEAM-1", ["paused", "area"], "TEAM", { state: BACKLOG }),
    newer: linear.addIssue("TEAM-2", ["paused"], "TEAM", { state: BACKLOG }),
    finished: linear.addIssue("TEAM-3", ["paused"], "TEAM", { state: { id: "state-done", type: "completed" } }),
    plain: linear.addIssue("TEAM-4", [], "TEAM", { state: BACKLOG }),
    elsewhere: linear.addIssue("OTHER-1", ["paused"], "OTHER", { state: BACKLOG }),
  };
}

test("the Paused list holds the team's open paused issues, newest first, and nothing else", async () => {
  const { harness, linear } = await setup();
  seed(linear);
  const panel = await refresh(harness);
  assert.deepEqual(panel.paused.map((issue) => [issue.identifier, issue.state]), [["TEAM-2", "Backlog"], ["TEAM-1", "Backlog"]]);
  assert.equal(panel.paused[0]!.url, "https://linear.example/TEAM-2");
  assert.equal(panel.pausedError, null);
});

test("Resume comments as the owner, removes the paused label, moves the issue to Todo, and tells the steward once", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { older } = seed(linear);
  await refresh(harness);
  const result = await resume(harness, "TEAM-1", "The answer is on the issue.");
  assert.deepEqual([result.identifier, result.steward, result.resumed], ["TEAM-1", "sent", false]);
  assert.deepEqual(older.comments.map((comment) => comment.body), ["Resumed (from the SGC page)\n\nThe answer is on the issue."]);
  assert.equal(older.comments[0]!.id, result.commentId);
  assert.deepEqual(older.labels.map((label) => label.name), ["area"]);
  assert.deepEqual(older.state, { id: "state-todo", type: "unstarted" });
  assert.deepEqual(sends.map((send) => [send.threadId, send.mode, send.input[0]!.text]), [
    [STEWARD, "queue-if-active", "[sgc-steward] Resumed TEAM-1: Title of TEAM-1\nThe answer is on the issue."],
  ]);
  assert.deepEqual((await harness.behavior.callRpc("questions.list", null) as Panel).paused.map((issue) => issue.identifier), ["TEAM-2"]);
});

test("a repeat Resume of a finished one refuses and posts no second comment", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { older } = seed(linear);
  await resume(harness, "TEAM-1");
  const again = await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-1", note: "" }));
  assert.equal(again.code, "conflict");
  assert.match(again.message, /not paused/);
  assert.equal(older.comments.length, 1);
  assert.equal(sends.length, 1);
});

test("a Resume whose state change failed finishes on retry: one comment, one message", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { older } = seed(linear);
  linear.setStateFaults = ["dropped"];
  const failed = await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-1", note: "First note." }));
  assert.match(failed.message, /comment is posted on TEAM-1, but Linear did not take the change/);
  assert.equal(older.comments.length, 1);
  assert.equal(sends.length, 0, "nothing is told before the job is done");
  assert.deepEqual(older.state, BACKLOG);
  // The label is already off, so the issue left the list, but the retry still finishes the job.
  const result = await resume(harness, "TEAM-1", "A different note, which is not used.");
  assert.deepEqual([result.steward, result.resumed], ["sent", true]);
  assert.deepEqual(older.comments.map((comment) => comment.body), ["Resumed (from the SGC page)\n\nFirst note."]);
  assert.deepEqual(older.state, { id: "state-todo", type: "unstarted" });
  assert.deepEqual(sends.map((send) => send.input[0]!.text), ["[sgc-steward] Resumed TEAM-1: Title of TEAM-1\nFirst note."]);
});

test("a Resume whose state change landed but whose reply was lost finishes without writing it again", async () => {
  const { harness, linear, sends } = await setup();
  await harness.behavior.setSettings({ stewardThread: STEWARD });
  const { older } = seed(linear);
  linear.setStateFaults = ["lost"];
  const result = await resume(harness, "TEAM-1");
  assert.equal(result.steward, "sent");
  assert.deepEqual(older.state, { id: "state-todo", type: "unstarted" });
  assert.equal(older.comments.length, 1);
  assert.equal(sends.length, 1);
});

test("Resume refuses an unknown issue, one in another team, and one that is not paused, and writes nothing", async () => {
  const { harness, linear } = await setup();
  const { plain, elsewhere } = seed(linear);
  const missing = await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-404", note: "" }));
  assert.equal(missing.code, "not_found");
  const other = await rejection(harness.behavior.callRpc("paused.resume", { issue: "OTHER-1", note: "" }));
  assert.equal(other.code, "invalid");
  const notPaused = await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-4", note: "" }));
  assert.equal(notPaused.code, "conflict");
  assert.deepEqual([plain.comments.length, elsewhere.comments.length], [0, 0]);
});

test("with no steward thread Resume still changes Linear and sends nothing", async () => {
  const { harness, linear, sends } = await setup();
  const { older } = seed(linear);
  const result = await resume(harness, "TEAM-1");
  assert.equal(result.steward, "skipped");
  assert.deepEqual(older.state, { id: "state-todo", type: "unstarted" });
  assert.equal(sends.length, 0);
});

test("bb sgc paused lists paused issues and expired questions, and bb sgc resume resumes one", async () => {
  const clock = { at: Date.parse("2026-11-20T10:00:00Z") };
  const { harness, linear, refresh: poll } = await setup({ now: () => clock.at });
  const { older } = seed(linear);
  const asked = await harness.behavior.runCli(["ask", "--label", "Project", "--question", "Ship?", "--issue", "TEAM-1", "--json"], { threadId: "thr_asker", cwd: "/work" });
  const { id } = JSON.parse(asked.stdout) as { id: string };
  clock.at += 3 * 86_400_000;
  await poll();
  const json = JSON.parse((await harness.behavior.runCli(["paused", "--cached", "--json"])).stdout) as { paused: Array<{ identifier: string }>; expired: Array<{ id: string; issue: string }> };
  assert.deepEqual(json.paused.map((issue) => issue.identifier), ["TEAM-2", "TEAM-1"]);
  assert.deepEqual(json.expired.map((row) => [row.id, row.issue]), [[id, "TEAM-1"]]);
  const text = await harness.behavior.runCli(["paused", "--cached"]);
  assert.match(text.stdout, /^TEAM-2  Title of TEAM-2  \[Backlog\]\n  https:\/\/linear\.example\/TEAM-2\n/, "the CLI keeps https links");
  assert.match(text.stdout, new RegExp(`${id}  from Title of thr_asker \\(thr_asker\\), expired .*issue TEAM-1`));
  assert.match(text.stdout, /Resume: bb sgc resume <issue> \[--note <text>\]/);
  const resumed = await harness.behavior.runCli(["resume", "TEAM-1", "--note", "Go on."]);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.match(resumed.stdout, /^Resumed TEAM-1: removed the paused label and moved it to Todo\./);
  assert.ok(older.comments.some((comment) => comment.body === "Resumed (from the SGC page)\n\nGo on."));
  const twice = await harness.behavior.runCli(["resume", "TEAM-1"]);
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr, /not paused/);
});

test("a paused read that fails is reported on its own, and the questions still poll", async () => {
  const { harness, linear } = await setup();
  linear.addIssue("TEAM-1", ["checkin"]);
  linear.listPausedIssues = async () => {
    throw new Error("Linear refused the request: label filter");
  };
  const panel = await refresh(harness);
  assert.equal(panel.error, null);
  assert.match(panel.pausedError ?? "", /label filter/);
});

test("Resume refuses a completed or canceled issue that kept the paused label, and writes nothing", async () => {
  const { harness, linear } = await setup();
  const { finished } = seed(linear);
  const refused = await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-3", note: "" }));
  assert.equal(refused.code, "conflict");
  assert.match(refused.message, /completed|canceled/);
  assert.equal(finished.comments.length, 0);
  assert.deepEqual(finished.state, { id: "state-done", type: "completed" });
  assert.ok(finished.labels.some((label) => label.name === "paused"));
});

test("the Paused list keeps the Resume button available after a failed Todo move", async () => {
  const { harness, linear } = await setup();
  const issue = linear.addIssue("TEAM-1", ["paused"], "TEAM", { state: BACKLOG });
  await refresh(harness);
  linear.setStateFaults = ["dropped"];

  const failed = await rejection(harness.behavior.callRpc("paused.resume", { issue: issue.identifier, note: "" }));
  assert.match(failed.message, /Press Resume again/);
  assert.deepEqual(issue.state, BACKLOG);

  const panel = await refresh(harness);
  assert.deepEqual(panel.paused.map((row) => row.identifier), [issue.identifier]);
});

test("bb sgc paused reports a failed Linear refresh instead of returning stale rows as success", async () => {
  const { harness, linear } = await setup();
  linear.addIssue("TEAM-1", ["paused"], "TEAM", { state: BACKLOG });
  assert.deepEqual((await refresh(harness)).paused.map((row) => row.identifier), ["TEAM-1"]);
  linear.listQuestionIssues = async () => {
    throw new Error("Linear is unavailable");
  };

  const result = await harness.behavior.runCli(["paused", "--json"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Linear is unavailable/);
});

test("a pending Resume's issue that moved to another team is not listed", async () => {
  const { harness, linear } = await setup();
  const issue = linear.addIssue("TEAM-1", ["paused"], "TEAM", { state: BACKLOG });
  linear.setStateFaults = ["dropped"];
  await rejection(harness.behavior.callRpc("paused.resume", { issue: "TEAM-1", note: "" }));
  issue.teamKey = "OTHER";
  assert.deepEqual((await refresh(harness)).paused, []);
});
