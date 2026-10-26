import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "./server.ts";
import { askDelivery, askRecord, blockDelivery, type Ask } from "./lib/asks.ts";
import { LinearError } from "./lib/linear.ts";
import { answerCommentId } from "./lib/questions.ts";
import { KEY, QUESTIONS, rejection, revisionOf, setup } from "./test-support.ts";

type Harness = Awaited<ReturnType<typeof setup>>["harness"];

const list = async (harness: Harness) => (await harness.behavior.callRpc("questions.list", null)) as Panel;

/** `threadId` null runs the command outside any thread. */
function ask(harness: Harness, args: string[], threadId: string | null = "thr_asker") {
  return harness.behavior.runCli(["ask", ...args], threadId === null ? { cwd: "/work" } : { threadId, cwd: "/work" });
}

async function askId(harness: Harness, args: string[], threadId = "thr_asker"): Promise<string> {
  const result = await ask(harness, [...args, "--json"], threadId);
  assert.equal(result.exitCode, 0, result.stderr);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

function asAsk(view: Panel["asks"][number]): Ask {
  return { id: view.id, threadId: view.threadId, threadTitle: view.threadTitle, question: view.question, options: view.options, issue: view.issue, askedAt: view.askedAt };
}

test("an agent asks without waiting: the command stores the question and returns its id", async () => {
  const { harness, linear } = await setup();
  const result = await ask(harness, ["--question", "Ship the cache change today?", "--option", "Yes, today.", "--option", "No, wait.", "--issue", "TEAM-12", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const { id, existing } = JSON.parse(result.stdout) as { id: string; existing: boolean };
  assert.match(id, /^bbq_[a-z0-9]{10}$/);
  assert.equal(existing, false);
  assert.deepEqual(linear.calls, [], "asking reads nothing from Linear");
  const panel = await list(harness);
  assert.deepEqual(
    panel.asks.map((open) => [open.id, open.threadId, open.threadTitle, open.question, open.issue]),
    [[id, "thr_asker", "Title of thr_asker", "Ship the cache change today?", "TEAM-12"]],
  );
  assert.deepEqual(panel.asks[0]!.options, [
    { letter: "A", text: "Yes, today.", recommended: true },
    { letter: "B", text: "No, wait.", recommended: false },
  ]);
  const signals = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "questions");
  assert.deepEqual(signals.at(-1)?.payload, { newBlocks: 1 });

  const plain = await ask(harness, ["--question", "Which branch?", "--option", "main", "--option", "next", "--recommend", "B"]);
  assert.match(plain.stdout, /^Asked (bbq_[a-z0-9]{10})\. Keep working: the answer arrives in this thread as a message that starts with "\[sgc-steward\] Answer to \1"\.$/);
  assert.deepEqual((await list(harness)).asks[1]!.options.map((option) => option.recommended), [false, true]);
  await askId(harness, ["--question", "Free form?", "--option", "x", "--recommend", "none"]);
  assert.deepEqual((await list(harness)).asks[2]!.options.map((option) => option.recommended), [false]);
});

test("asking the same open question again returns its id, and a thread can have only so many open", async () => {
  const { harness } = await setup();
  const first = await askId(harness, ["--question", "Same?", "--option", "Yes."]);
  const again = await ask(harness, ["--question", "Same?", "--option", "Yes.", "--json"]);
  assert.deepEqual(JSON.parse(again.stdout), { id: first, existing: true });
  for (let n = 2; n <= 10; n += 1) await askId(harness, ["--question", `Question ${n}?`]);
  const eleventh = await ask(harness, ["--question", "Question 11?"]);
  assert.equal(eleventh.exitCode, 1);
  assert.match(eleventh.stderr, /thr_asker already has 10 open questions/);
  await askId(harness, ["--question", "Question 11?"], "thr_other");
});

test("ask refuses without a thread, for an unknown thread, a bad issue, an empty question, or a bad recommendation", async () => {
  const { harness } = await setup();
  const none = await ask(harness, ["--question", "Who asks?"], null);
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /--thread/);
  harness.inspection.sdk.stub("threads.get", async () => {
    throw new Error("thread not found");
  });
  const gone = await ask(harness, ["--question", "Anyone?"], "thr_gone");
  assert.equal(gone.exitCode, 1);
  assert.match(gone.stderr, /No bb thread thr_gone/);
  harness.inspection.sdk.stub("threads.get", async () => ({ id: "thr_asker", title: "Asker", titleFallback: null, environmentId: null }));
  for (const [args, problem] of [
    [["--question", "x", "--issue", "team-1"], /not an issue identifier/],
    [["--question", "  "], /the question is empty/],
    [["--question", "x", "--option", "a", "--option", "b", "--recommend", "C"], /there is no option C to recommend/],
    [["--question", "x", "--thread", "not-a-thread"], /not a bb thread id/],
  ] as const) {
    const result = await ask(harness, [...args]);
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.match(result.stderr, problem);
  }
  assert.deepEqual((await list(harness)).asks, []);
});

test("asked questions survive a plugin reload", async () => {
  const { harness, factory } = await setup();
  const id = await askId(harness, ["--question", "Still here after a restart?"]);
  const reloaded = await harness.lifecycle.reload(factory);
  assert.deepEqual((await list(reloaded.harness)).asks.map((open) => open.id), [id]);
});

test("only the asking thread withdraws its question, and only while it is open", async () => {
  const { harness } = await setup();
  const id = await askId(harness, ["--question", "Withdraw me?"]);
  const other = await harness.behavior.runCli(["withdraw", id], { threadId: "thr_other" });
  assert.equal(other.exitCode, 1);
  assert.match(other.stderr, /asked by another thread/);
  const own = await harness.behavior.runCli(["withdraw", id], { threadId: "thr_asker" });
  assert.equal(own.exitCode, 0, own.stderr);
  assert.match(own.stdout, new RegExp(`Withdrew ${id}`));
  assert.deepEqual((await list(harness)).asks, []);
  const twice = await harness.behavior.runCli(["withdraw", id], { threadId: "thr_asker" });
  assert.match(twice.stderr, /is not open/);
  const answered = await rejection(harness.behavior.callRpc("asks.answer", { id, option: null, text: "Too late." }));
  assert.equal(answered.code, "conflict");
});

test("an answer goes to the asking thread as a queued message quoting the question and the answer", async () => {
  const { harness, sends } = await setup();
  const id = await askId(harness, ["--question", "Ship it?\nIt touches `the router`.", "--option", "Yes.", "--option", "No."]);
  const asked = asAsk((await list(harness)).asks[0]!);
  const answer = { option: "B", text: "Soak until Friday." };
  const result = await harness.behavior.callRpc("asks.answer", { id, ...answer });
  assert.deepEqual(result, { id, delivered: true, deliveryError: null, record: "none", recordError: null });
  assert.deepEqual(sends, [{ threadId: "thr_asker", mode: "queue-if-active", input: [{ type: "text", text: askDelivery(asked, answer), mentions: [] }] }]);
  const panel = await list(harness);
  assert.deepEqual([panel.asks, panel.undelivered], [[], []]);
  assert.equal((await rejection(harness.behavior.callRpc("asks.answer", { id, option: "A", text: "" }))).code, "conflict");
  const other = await askId(harness, ["--question", "Pick one?", "--option", "Yes."]);
  const bad = await rejection(harness.behavior.callRpc("asks.answer", { id: other, option: "C", text: "" }));
  assert.equal(bad.code, "invalid");
  assert.match(bad.message, /there is no option C/);
  assert.equal((await rejection(harness.behavior.callRpc("asks.answer", { id: "bbq_missing000", option: null, text: "x" }))).code, "not_found");
});

test("a failed send keeps the answer as undelivered, and a retry delivers it once", async () => {
  const { harness, sends } = await setup();
  const id = await askId(harness, ["--question", "Ship it?"]);
  harness.inspection.sdk.stub("threads.send", async () => {
    throw new Error("thread thr_asker was deleted");
  });
  const result = (await harness.behavior.callRpc("asks.answer", { id, option: null, text: "Yes." })) as { delivered: boolean; deliveryError: string };
  assert.equal(result.delivered, false);
  assert.match(result.deliveryError, /was deleted/);
  const failed = (await list(harness)).undelivered;
  assert.deepEqual(
    failed.map((row) => [row.source, row.ref, row.threadId, row.label, row.state, row.attempts]),
    [["ask", id, "thr_asker", id, "failed", 1]],
  );
  harness.inspection.sdk.stub("threads.send", async (args: unknown) => {
    sends.push(args as (typeof sends)[number]);
    return {};
  });
  assert.deepEqual(await harness.behavior.callRpc("deliveries.retry", { id: failed[0]!.id }), { delivered: true, error: null });
  assert.deepEqual((await list(harness)).undelivered, []);
  assert.deepEqual(await harness.behavior.callRpc("deliveries.retry", { id: failed[0]!.id }), { delivered: true, error: null });
  assert.equal(sends.length, 1, "a delivered answer is not sent again");
});

test("an answer to a question that names an issue is recorded there once, and closes no block", async () => {
  const { harness, linear, refresh } = await setup();
  const issue = linear.addIssue("TEAM-12", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  await refresh();
  const id = await askId(harness, ["--question", "Use the org id?", "--option", "Yes.", "--option", "No.", "--issue", "TEAM-12"]);
  const asked = asAsk((await list(harness)).asks[0]!);
  const result = await harness.behavior.callRpc("asks.answer", { id, option: "A", text: "" });
  assert.deepEqual(result, { id, delivered: true, deliveryError: null, record: "posted", recordError: null });
  const record = issue.comments.at(-1)!;
  assert.equal(record.body, askRecord(asked, { option: "A", text: "" }));
  assert.equal(record.id, answerCommentId("uuid-TEAM-12", record.body));
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 1);
  assert.deepEqual((await refresh()).issues.map((open) => [open.identifier, open.blocks.map((block) => block.commentId)]), [["TEAM-12", ["q1"]]]);
});

test("a record that fails is kept, listed, and posted by a retry", async () => {
  const { harness, linear } = await setup({ key: null });
  const id = await askId(harness, ["--question", "Use the org id?", "--issue", "TEAM-12"]);
  const result = (await harness.behavior.callRpc("asks.answer", { id, option: null, text: "Yes." })) as { record: string; recordError: string };
  assert.equal(result.record, "failed");
  assert.match(result.recordError, /API key is not set/);
  assert.deepEqual((await list(harness)).unposted.map((row) => [row.askId, row.issue, row.state]), [[id, "TEAM-12", "failed"]]);
  await harness.behavior.setSettings({ linearApiKey: KEY });
  const issue = linear.addIssue("TEAM-12", ["checkin"]);
  assert.deepEqual(await harness.behavior.callRpc("records.retry", { askId: id }), { posted: true, error: null });
  assert.equal(issue.comments.length, 1);
  assert.deepEqual((await list(harness)).unposted, []);
  assert.deepEqual(await harness.behavior.callRpc("records.retry", { askId: id }), { posted: true, error: null });
  assert.equal(issue.comments.length, 1, "a posted record is not posted again");
});

test("answering a Linear block also delivers the answer to the thread that signed it", async () => {
  const { harness, linear, refresh, sends } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();
  const result = (await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  })) as { notified: unknown };
  assert.deepEqual(result.notified, [{ threadId: "thr_test1", delivered: true, error: null }]);
  const posted = issue.comments.at(-1)!;
  assert.deepEqual(sends, [{ threadId: "thr_test1", mode: "queue-if-active", input: [{ type: "text", text: blockDelivery("TEAM-1", posted.id, posted.body), mentions: [] }] }]);
});

test("a resubmitted Linear answer that already landed counts as posted, and is delivered once", async () => {
  const { harness, linear, refresh, sends } = await setup();
  const issue = linear.addIssue("TEAM-1", ["needs-decision"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();
  const input = {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  };
  const createComment = linear.createComment.bind(linear);
  const pending: Array<Parameters<typeof linear.createComment>[0]> = [];
  linear.createComment = async (args) => {
    pending.push(args);
    throw new LinearError("timeout", "Linear did not answer within 30 s.");
  };
  await rejection(harness.behavior.callRpc("questions.answer", input));
  assert.deepEqual(sends, [], "no delivery for an answer that is not known to be posted");
  linear.createComment = createComment;
  await createComment(pending[0]!);
  const result = (await harness.behavior.callRpc("questions.answer", input)) as { commentId: string; labelRemoved: boolean; notified: unknown };
  assert.equal(result.commentId, pending[0]!.commentId);
  assert.equal(result.labelRemoved, true, "the label step that the failed try skipped runs now");
  assert.deepEqual(result.notified, [{ threadId: "thr_test1", delivered: true, error: null }]);
  await harness.behavior.callRpc("questions.answer", input);
  assert.equal(sends.length, 1, "the answer reaches the thread once");
  assert.equal(issue.comments.filter((comment) => !comment.body.startsWith("[agent:")).length, 1);
});

test("a signature that is not a bb thread id gets no delivery", async () => {
  const { harness, linear, refresh, sends } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS.replace("thr_test1", "session-42"));
  const shown = await refresh();
  const result = (await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  })) as { notified: unknown };
  assert.deepEqual(result.notified, []);
  assert.deepEqual(sends, []);
});

test("a new bb question is announced once, beside new Linear blocks", async () => {
  const { harness, linear, refresh, claim } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  await refresh();
  const id = await askId(harness, ["--question", "Ship it?\nDetails follow."]);
  const notices = (await claim()).notifications;
  assert.deepEqual(
    notices.map((notice) => [notice.source, notice.id, notice.label, notice.questionCount, notice.preview]),
    [
      ["linear", "q1", "TEAM-1", 2, "Which scale do estimates use?"],
      ["ask", id, "Title of thr_asker", 1, "Ship it?"],
    ],
  );
  assert.deepEqual((await claim()).notifications, []);
  await harness.behavior.setSettings({ notify: false });
  await askId(harness, ["--question", "Quiet?"]);
  await harness.behavior.setSettings({ notify: true });
  assert.deepEqual((await claim()).notifications, [], "a question asked while notifications were off stays quiet");
});

test("without a Linear key, asked questions still list, and the CLI says Linear is not set up", async () => {
  const { harness } = await setup({ key: null });
  const id = await askId(harness, ["--question", "Works without Linear?"]);
  const panel = await list(harness);
  assert.equal(panel.configured, false);
  assert.deepEqual(panel.asks.map((open) => open.id), [id]);
  const cli = await harness.behavior.runCli(["questions"]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, new RegExp(id));
  assert.match(cli.stderr, /Linear API key is not set/);
});

test("bb sgc questions prints asked questions and the answers that did not go out", async () => {
  const { harness } = await setup();
  const id = await askId(harness, ["--question", "Ship it?", "--option", "Yes.", "--option", "No.", "--issue", "TEAM-12"]);
  const listed = await harness.behavior.runCli(["questions"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`${id} {2}from Title of thr_asker \\(thr_asker\\), asked \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC, issue TEAM-12`));
  assert.match(listed.stdout, /Ship it\?\n\s+A \(recommended\): Yes\.\n\s+B: No\./);
  harness.inspection.sdk.stub("threads.send", async () => {
    throw new Error("thread is archived");
  });
  await harness.behavior.callRpc("asks.answer", { id, option: "A", text: "" });
  const after = await harness.behavior.runCli(["questions"]);
  assert.match(after.stdout, new RegExp(`Answers not delivered:\\n\\s+${id} to thr_asker: thread is archived \\(1 try\\)`));
  assert.match(after.stdout, new RegExp(`Records not posted to Linear:\\n\\s+${id} on TEAM-12: Linear has no issue TEAM-12\\.`));
});
