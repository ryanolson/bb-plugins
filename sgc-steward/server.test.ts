import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createSgcStewardPlugin, type Snapshot } from "./server.ts";
import { createLinearClient, LinearError, type LinearClient, type LinearIssue } from "./lib/linear.ts";
import type { LinearComment } from "./lib/questions.ts";

const KEY = "lin_api_test_not_a_real_key";

const QUESTIONS = [
  "[agent:claude-code thr_test1] Questions 2026-01-05",
  "Q1. Which scale do estimates use?",
  "- A (recommended): Powers of two.",
  "- B: Small, medium, large.",
  "Q2. Which project goes first?",
].join("\n");

interface FakeIssue extends LinearIssue {
  comments: LinearComment[];
}

/** An in-memory Linear with the client's surface and a call log. */
class FakeLinear implements LinearClient {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  keys: string[] = [];
  /** "lost": the write lands but the response is lost. "dropped": it never lands. */
  createFaults: Array<"lost" | "dropped"> = [];
  createFaultKind: "network" | "timeout" = "network";
  removeLabelFaults: Array<"lost" | "dropped"> = [];
  private clock = Date.parse("2026-01-05T10:00:00Z");

  tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  addIssue(identifier: string, labels: string[], teamKey = "TEAM"): FakeIssue {
    const issue: FakeIssue = {
      id: `uuid-${identifier}`,
      identifier,
      title: `Title of ${identifier}`,
      url: `https://linear.example/${identifier}`,
      updatedAt: this.tick(),
      teamKey,
      state: { type: "started" },
      labels: labels.map((name) => ({ id: `label-${name}`, name })),
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  post(issue: FakeIssue, id: string, body: string, author: "user" | "bot" = "user"): void {
    issue.comments.push({ id, body, createdAt: this.tick(), author, parentId: null });
    issue.updatedAt = this.tick();
  }

  find(id: string): FakeIssue | undefined {
    return this.issues.find((issue) => issue.id === id || issue.identifier === id);
  }

  strip(issue: FakeIssue): LinearIssue {
    const { comments: _comments, ...rest } = issue;
    return structuredClone(rest);
  }

  async listQuestionIssues(teamKey: string) {
    this.calls.push(`listQuestionIssues ${teamKey}`);
    return this.issues
      .filter((issue) => issue.teamKey === teamKey && issue.labels.some((label) => ["checkin", "needs-decision"].includes(label.name)))
      .map((issue) => this.strip(issue));
  }

  async getIssue(id: string) {
    this.calls.push(`getIssue ${id}`);
    const issue = this.find(id);
    return issue === undefined ? null : this.strip(issue);
  }

  async listComments(issueId: string) {
    this.calls.push(`listComments ${issueId}`);
    return structuredClone(this.find(issueId)!.comments);
  }

  async createComment({ issueId, body, commentId }: { issueId: string; body: string; commentId: string }) {
    this.calls.push(`createComment ${issueId} ${commentId}`);
    const issue = this.find(issueId)!;
    if (issue.comments.some((comment) => comment.id === commentId)) {
      throw new LinearError("graphql", "Linear refused the request: duplicate id");
    }
    const fault = this.createFaults.shift();
    if (fault !== "dropped") this.post(issue, commentId, body);
    if (fault !== undefined) throw new LinearError(this.createFaultKind, "could not reach Linear: socket hang up");
    return commentId;
  }

  async removeLabel({ issueId, labelId }: { issueId: string; labelId: string }) {
    this.calls.push(`removeLabel ${issueId} ${labelId}`);
    const fault = this.removeLabelFaults.shift();
    if (fault !== "dropped") {
      const issue = this.find(issueId)!;
      issue.labels = issue.labels.filter((label) => label.id !== labelId);
      issue.updatedAt = this.tick();
    }
    if (fault !== undefined) throw new LinearError("network", "could not reach Linear: socket hang up");
  }
}

async function setup(options: { key?: string | null } = {}) {
  const linear = new FakeLinear();
  let ids = 0;
  const plugin = createSgcStewardPlugin({
    createClient: (apiKey) => {
      linear.keys.push(apiKey);
      return linear;
    },
    newId: () => `posted-${++ids}`,
    retryDelayMs: 0,
  });
  const settings: Record<string, string> = options.key === null ? { teamKey: "TEAM" } : { linearApiKey: options.key ?? KEY, teamKey: "TEAM" };
  const host = createFakePluginHost({ pluginId: "sgc-steward", settings });
  await plugin(host.bb);
  const { harness } = host;
  const refresh = async () => (await harness.behavior.callRpc("questions.refresh", null)) as Snapshot;
  const claim = async () =>
    (await harness.behavior.callRpc("notifications.claim", null)) as { notifications: Array<{ blockId: string; issueIdentifier: string; preview: string }> };
  return { linear, harness, refresh, claim };
}

function revisionOf(snapshot: Snapshot, blockId: string): string {
  for (const issue of snapshot.issues) for (const block of issue.blocks) if (block.commentId === blockId) return block.revision;
  assert.fail(`no open block ${blockId}`);
}

async function rejection(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; code?: string };
  }
  assert.fail("expected a rejection");
}

test("without a key the plugin asks for one and never calls Linear", async () => {
  const { linear, harness, refresh } = await setup({ key: null });
  assert.equal(harness.inspection.needsConfigurationMessages.length, 1);
  assert.match(harness.inspection.needsConfigurationMessages[0]!, /bb sgc key --api-key-stdin/);
  const snapshot = await refresh();
  assert.equal(snapshot.configured, false);
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(linear.calls, []);
  const cli = await harness.behavior.runCli(["questions"]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderr, /bb sgc key --api-key-stdin/);
});

test("a poll lists open questions grouped by issue, and skips answered ones", async () => {
  const { linear, refresh } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  const decision = linear.addIssue("TEAM-2", ["needs-decision", "area"]);
  linear.post(decision, "d1", "[agent:codex thr_test2] Should the cache key include the tenant?");
  const answered = linear.addIssue("TEAM-3", ["checkin"]);
  linear.post(answered, "q3", QUESTIONS);
  linear.post(answered, "a3", "Q1. A");
  const elsewhere = linear.addIssue("OTHER-1", ["checkin"], "OTHER");
  linear.post(elsewhere, "q4", QUESTIONS);

  const snapshot = await refresh();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.error, null);
  assert.deepEqual(
    snapshot.issues.map((issue) => [issue.identifier, issue.kind, issue.blocks.map((block) => [block.commentId, block.format])]),
    [
      ["TEAM-1", "checkin", [["q1", "parsed"]]],
      ["TEAM-2", "needs-decision", [["d1", "raw"]]],
    ],
  );
  assert.deepEqual(linear.keys, [KEY]);
});

test("unchanged issues reuse their comments; a refresh from the panel reads them again", async () => {
  const { linear, harness } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  const poll = (force: boolean) => harness.behavior.callRpc(force ? "questions.refresh" : "questions.list", null);
  await poll(true);
  linear.calls.length = 0;
  const cli = await harness.behavior.runCli(["questions", "--cached"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.deepEqual(linear.calls, [], "--cached reads nothing from Linear");
  await harness.behavior.runCli(["questions"]);
  assert.deepEqual(linear.calls, ["listQuestionIssues TEAM"], "the issue did not change, so its comments come from the cache");
  linear.calls.length = 0;
  await poll(true);
  assert.deepEqual(linear.calls, ["listQuestionIssues TEAM", "listComments uuid-TEAM-1"]);
});

test("each new question block is handed out for a notification exactly once", async () => {
  const { linear, harness, refresh, claim } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  await refresh();
  const signals = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "questions");
  assert.deepEqual(signals.at(-1)?.payload, { newBlocks: 1 });

  const first = await claim();
  assert.deepEqual(first.notifications.map((note) => [note.blockId, note.issueIdentifier]), [["q1", "TEAM-1"]]);
  assert.match(first.notifications[0]!.preview, /Which scale do estimates use\?/);
  assert.deepEqual((await claim()).notifications, [], "a second window gets nothing");

  await refresh();
  assert.deepEqual((await claim()).notifications, [], "polling again does not notify again");

  linear.post(checkin, "q2", QUESTIONS.replace("2026-01-05", "2026-01-06"));
  await refresh();
  assert.deepEqual((await claim()).notifications.map((note) => note.blockId), ["q2"]);
});

test("notifications can be turned off", async () => {
  const { linear, harness, refresh, claim } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  await harness.behavior.setSettings({ notify: false });
  await refresh();
  assert.deepEqual((await claim()).notifications, []);
  await harness.behavior.setSettings({ notify: true });
  assert.deepEqual((await claim()).notifications, [], "blocks seen while off stay quiet");
});

test("answering posts one unsigned comment numbered to match and closes the block", async () => {
  const { linear, harness, refresh } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  const shown = await refresh();
  const result = await harness.behavior.callRpc("questions.answer", {
    issueId: "uuid-TEAM-1",
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  });
  assert.deepEqual(result, { identifier: "TEAM-1", commentId: "posted-1", labelRemoved: null, warning: null });
  assert.equal(
    checkin.comments.at(-1)?.body,
    [`Answers to the questions of 2026-01-05 (block q1 rev ${revisionOf(shown, "q1")})`, "", "Q1. A: Powers of two.", "", "Q2. No answer."].join("\n"),
  );
  const snapshot = (await harness.behavior.callRpc("questions.list", null)) as Snapshot;
  assert.deepEqual(snapshot.issues, []);
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 1);
});

test("answering a needs-decision issue also removes the label", async () => {
  const { linear, harness, refresh } = await setup();
  const decision = linear.addIssue("TEAM-2", ["needs-decision"]);
  linear.post(decision, "d1", "[agent:codex thr_test2] Should the cache key include the tenant?");
  const shown = await refresh();
  const result = await harness.behavior.callRpc("questions.answer", {
    issueId: "uuid-TEAM-2",
    blocks: [{ blockId: "d1", revision: revisionOf(shown, "d1"), answers: [], text: "Yes, use the org id." }],
  });
  assert.deepEqual(result, { identifier: "TEAM-2", commentId: "posted-1", labelRemoved: true, warning: null });
  assert.deepEqual(decision.labels, []);
  assert.equal(decision.comments.at(-1)!.body, `Answer to the question of 2026-01-05 (block d1 rev ${revisionOf(shown, "d1")})\n\nYes, use the org id.`);
});

test("a label that will not come off is retried, then reported, and the answer is not posted twice", async () => {
  const { linear, harness, refresh } = await setup();
  const decision = linear.addIssue("TEAM-2", ["needs-decision"]);
  linear.post(decision, "d1", "[agent:codex thr_test2] Which tenant key?");
  const shown = await refresh();
  linear.removeLabelFaults = ["dropped", "dropped", "dropped", "dropped"];
  const result = (await harness.behavior.callRpc("questions.answer", {
    issueId: "uuid-TEAM-2",
    blocks: [{ blockId: "d1", revision: revisionOf(shown, "d1"), answers: [], text: "The org id." }],
  })) as { labelRemoved: boolean; warning: string };
  assert.equal(result.labelRemoved, false);
  assert.match(result.warning, /answer is posted, but the needs-decision label is still on TEAM-2/);
  assert.equal(linear.calls.filter((call) => call.startsWith("removeLabel")).length, 3);
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 1);
});

test("a removal whose response was lost is seen as done", async () => {
  const { linear, harness, refresh } = await setup();
  const decision = linear.addIssue("TEAM-2", ["needs-decision"]);
  linear.post(decision, "d1", "[agent:codex thr_test2] Which tenant key?");
  const shown = await refresh();
  linear.removeLabelFaults = ["lost"];
  const result = await harness.behavior.callRpc("questions.answer", {
    issueId: "uuid-TEAM-2",
    blocks: [{ blockId: "d1", revision: revisionOf(shown, "d1"), answers: [], text: "The org id." }],
  });
  assert.deepEqual(result, { identifier: "TEAM-2", commentId: "posted-1", labelRemoved: true, warning: null });
  assert.equal(linear.calls.filter((call) => call.startsWith("removeLabel")).length, 1);
});

test("a post whose response was lost is found by its id and never posted twice", async () => {
  for (const [fault, kind] of [["lost", "network"], ["dropped", "network"], ["lost", "timeout"]] as const) {
    const { linear, harness, refresh } = await setup();
    linear.createFaultKind = kind;
    const checkin = linear.addIssue("TEAM-1", ["checkin"]);
    linear.post(checkin, "q1", QUESTIONS);
    const shown = await refresh();
    linear.createFaults = [fault];
    const result = await harness.behavior.callRpc("questions.answer", {
      issueId: "uuid-TEAM-1",
      blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
    });
    assert.deepEqual(result, { identifier: "TEAM-1", commentId: "posted-1", labelRemoved: null, warning: null }, fault);
    assert.deepEqual(
      checkin.comments.map((comment) => comment.id),
      ["q1", "posted-1"],
      fault,
    );
    const posts = linear.calls.filter((call) => call.startsWith("createComment"));
    assert.deepEqual(posts, fault === "lost" ? ["createComment uuid-TEAM-1 posted-1"] : ["createComment uuid-TEAM-1 posted-1", "createComment uuid-TEAM-1 posted-1"], fault);
  }
});

test("an answer is refused when the questions changed or were already answered", async () => {
  const { linear, harness, refresh } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  const shown = await refresh();
  const answer = { issueId: "uuid-TEAM-1", blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }] };

  linear.post(checkin, "q2", QUESTIONS);
  const changed = await rejection(harness.behavior.callRpc("questions.answer", answer));
  assert.equal(changed.code, "conflict");
  assert.match(changed.message, /questions on TEAM-1 changed/);

  linear.post(checkin, "a1", "Answered in Linear.");
  const answered = await rejection(harness.behavior.callRpc("questions.answer", answer));
  assert.equal(answered.code, "conflict");
  assert.match(answered.message, /TEAM-1 has no open questions/);
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 0);
});

test("answers that do not fit the questions are refused before anything is posted", async () => {
  const { linear, harness, refresh } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  const shown = await refresh();
  const bad = await rejection(
    harness.behavior.callRpc("questions.answer", {
      issueId: "uuid-TEAM-1",
      blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "Z", text: "" }] }],
    }),
  );
  assert.equal(bad.code, "invalid");
  assert.match(bad.message, /Q1 has no option Z/);
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 0);
});

test("bb sgc questions prints each question with the recommended option first", async () => {
  const { linear, harness } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS.replace("- A (recommended): Powers of two.\n- B: Small, medium, large.", "- A: Powers of two.\n- B (recommended): Small, medium, large."));
  const cli = await harness.behavior.runCli(["questions"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.match(cli.stdout, /TEAM-1 {2}Title of TEAM-1 {2}\[check-in\]/);
  assert.match(cli.stdout, /Q1\. Which scale do estimates use\?\n\s+B \(recommended\): Small, medium, large\.\n\s+A: Powers of two\./);
  assert.match(cli.stdout, /Questions 2026-01-05 from claude-code thr_test1 \(block q1@[0-9a-f]{12}\)/);
  assert.match(cli.stdout, /bb sgc answer TEAM-1 --block q1@[0-9a-f]{12} --text-file <file>/);
  const json = await harness.behavior.runCli(["questions", "--json"]);
  assert.equal((JSON.parse(json.stdout) as Snapshot).issues[0]?.identifier, "TEAM-1");
});

test("bb sgc answer reads the file on the invoking thread's machine and posts it under a header that names the block", async () => {
  const { linear, harness, refresh } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  const revision = revisionOf(await refresh(), "q1");
  const reads: unknown[] = [];
  harness.inspection.sdk.stub("threads.get", async () => ({ id: "thr_caller", environmentId: "env_1" }));
  harness.inspection.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_spark" }));
  harness.inspection.sdk.stub("files.read", async (args: unknown) => {
    reads.push(args);
    return { content: "Q1. A\nQ2. The cells.", contentEncoding: "utf8", path: "/work/answer.md", sha256: "x", sizeBytes: 20 };
  });
  const cli = await harness.behavior.runCli(["answer", "TEAM-1", "--block", `q1@${revision}`, "--text-file", "answer.md"], {
    cwd: "/work",
    threadId: "thr_caller",
  });
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.deepEqual(reads, [{ path: "/work/answer.md", hostId: "host_spark" }]);
  assert.equal(checkin.comments.at(-1)?.body, `Answers to the questions of 2026-01-05 (block q1 rev ${revision})\n\nQ1. A\nQ2. The cells.`);
  assert.match(cli.stdout, /Posted the answer to TEAM-1/);
});

test("bb sgc answer refuses a signed text, an issue with nothing open, a relative path with no directory, and a bad --block", async () => {
  const { linear, harness, refresh } = await setup();
  const checkin = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(checkin, "q1", QUESTIONS);
  const block = `q1@${revisionOf(await refresh(), "q1")}`;
  harness.inspection.sdk.stub("hosts.list", async () => [
    { id: "host_mac", name: "laptop" },
    { id: "host_spark", name: "spark" },
  ]);
  let text = "[agent:codex thr_x] I answer for Ryan";
  const reads: unknown[] = [];
  harness.inspection.sdk.stub("files.read", async (args: unknown) => {
    reads.push(args);
    return { content: Buffer.from(text).toString("base64"), contentEncoding: "base64", path: "/tmp/a.md", sha256: "x", sizeBytes: text.length };
  });
  const signed = await harness.behavior.runCli(["answer", "TEAM-1", "--block", block, "--text-file", "/tmp/a.md", "--machine", "laptop"]);
  assert.equal(signed.exitCode, 1);
  assert.match(signed.stderr, /starts with \[agent:/);
  assert.deepEqual(reads, [{ path: "/tmp/a.md", hostId: "host_mac" }]);

  const relative = await harness.behavior.runCli(["answer", "TEAM-1", "--block", block, "--text-file", "a.md"]);
  assert.equal(relative.exitCode, 1);
  assert.match(relative.stderr, /absolute path/);

  text = "Q1. A";
  const none = linear.addIssue("TEAM-9", ["checkin"]);
  const empty = await harness.behavior.runCli(["answer", "TEAM-9", "--block", "q9@000000000000", "--text-file", "/tmp/a.md"]);
  assert.equal(empty.exitCode, 1);
  assert.match(empty.stderr, /TEAM-9 has no open questions/);
  assert.deepEqual(none.comments, []);

  const missing = await harness.behavior.runCli(["answer", "TEAM-1", "--text-file", "/tmp/a.md"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /--block/);
  const malformed = await harness.behavior.runCli(["answer", "TEAM-1", "--block", "q1", "--text-file", "/tmp/a.md"]);
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /is not <comment id>@<revision>/);
  assert.equal(linear.calls.filter((call) => call.startsWith("createComment")).length, 0);
});

test("bb sgc key stores the key without printing it, and the next poll uses it", async () => {
  const { linear, harness, refresh } = await setup({ key: null });
  const cli = await harness.behavior.runCli(["key", "--api-key", " lin_api_fresh_key \n"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.ok(!cli.stdout.includes("lin_api_fresh_key") && !cli.stderr.includes("lin_api_fresh_key"));
  assert.match(cli.stdout, /Saved the Linear API key/);
  const snapshot = await refresh();
  assert.equal(snapshot.configured, true);
  assert.deepEqual(linear.keys, ["lin_api_fresh_key"]);
  assert.ok(!harness.inspection.logEntries.some((entry) => JSON.stringify(entry).includes("lin_api_fresh_key")));
});

test("a key with a line break or a space is refused on save, and the refusal does not echo it", async () => {
  const { harness } = await setup({ key: null });
  for (const bad of ["lin_api_pasted_secret\nsecond_line", "lin_api_pasted secret"]) {
    const refused = await rejection(harness.behavior.setSettings({ linearApiKey: bad }));
    assert.match(refused.message, /no spaces, line breaks, or other control characters/);
    assert.ok(!refused.message.includes("pasted"), refused.message);
  }
  const cli = await harness.behavior.runCli(["key", "--api-key", "lin_api_tab\tinside"]);
  assert.equal(cli.exitCode, 1);
  assert.ok(!cli.stderr.includes("lin_api_tab") && !cli.stdout.includes("lin_api_tab"), cli.stderr);
});

test("the poller polls at start, wakes on a settings change, and stops on abort", async () => {
  const { linear, harness } = await setup();
  const service = harness.behavior.runService("poller");
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), `timed out; calls: ${linear.calls.join(", ")}`);
  };
  await waitFor(() => linear.calls.includes("listQuestionIssues TEAM"));
  await harness.behavior.setSettings({ teamKey: "OTHER" });
  await waitFor(() => linear.calls.includes("listQuestionIssues OTHER"));
  service.controller.abort();
  await service.done;
});

test("an answer stops a stalled poll instead of waiting behind it, and the poller polls again", async () => {
  const { linear, harness, refresh } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();

  const listQuestionIssues = linear.listQuestionIssues.bind(linear);
  let stalls = 1;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  linear.listQuestionIssues = async (teamKey: string, signal?: AbortSignal) => {
    if (stalls === 0) return listQuestionIssues(teamKey);
    stalls -= 1;
    entered();
    // Never answers; only the abort signal ends it.
    return new Promise<LinearIssue[]>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new LinearError("aborted", "stopped")), { once: true });
    });
  };
  const service = harness.behavior.runService("poller");
  await started;
  const result = await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  });
  assert.deepEqual(result, { identifier: "TEAM-1", commentId: "posted-1", labelRemoved: null, warning: null });
  for (let attempt = 0; attempt < 200 && linear.calls.filter((call) => call === "listQuestionIssues TEAM").length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(linear.calls.filter((call) => call === "listQuestionIssues TEAM").length, 2, "the poller polls again after the answer");
  const after = (await harness.behavior.callRpc("questions.list", null)) as Snapshot;
  assert.equal(after.error, null, "a stopped poll records no error");
  service.controller.abort();
  await service.done;
});

test("bb sgc questions polls again when an answer stops its poll, instead of printing old questions", async () => {
  const { linear, harness, refresh } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();
  const listQuestionIssues = linear.listQuestionIssues.bind(linear);
  let stalls = 1;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  linear.listQuestionIssues = async (teamKey: string, signal?: AbortSignal) => {
    if (stalls === 0) return listQuestionIssues(teamKey);
    stalls -= 1;
    entered();
    return new Promise<LinearIssue[]>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new LinearError("aborted", "stopped")), { once: true });
    });
  };
  const cli = harness.behavior.runCli(["questions", "--json"]);
  await started;
  await harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  });
  const result = await cli;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual((JSON.parse(result.stdout) as Snapshot).issues, [], "the second poll sees the answer");
});

test("an issue past the reading limits shows as unreadable, and the other issues still show", async () => {
  const { linear, refresh } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  linear.post(linear.addIssue("TEAM-2", ["checkin"]), "q2", QUESTIONS);
  const listComments = linear.listComments.bind(linear);
  linear.listComments = async (issueId: string) => {
    if (issueId === "uuid-TEAM-1") {
      throw new LinearError("limit", "the issue has more than 1000 comments, so the plugin does not guess which questions are open");
    }
    return listComments(issueId);
  };
  const snapshot = await refresh();
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.issues.map((issue) => issue.identifier), ["TEAM-2"]);
  assert.deepEqual(snapshot.issueErrors.map((failed) => failed.identifier), ["TEAM-1"]);
  assert.match(snapshot.issueErrors[0]!.message, /does not guess/);
});

test("a failed poll keeps the last questions and reports the error", async () => {
  const { linear, refresh } = await setup();
  linear.post(linear.addIssue("TEAM-1", ["checkin"]), "q1", QUESTIONS);
  const good = await refresh();
  linear.listQuestionIssues = async () => {
    throw new LinearError("auth", "Linear rejected the API key (HTTP 401).");
  };
  const bad = await refresh();
  assert.match(bad.error ?? "", /rejected the API key/);
  assert.deepEqual(bad.issues, good.issues);
  assert.equal(bad.polledAt, good.polledAt);
});

test("review F1: editing an option refuses the answer drafted before the edit", async () => {
  const { linear, harness, refresh } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();
  assert.equal(shown.issues[0]?.blocks[0]?.commentId, "q1");

  issue.comments[0]!.body = QUESTIONS.replace(
    "- A (recommended): Powers of two.\n- B: Small, medium, large.",
    "- A (recommended): Small, medium, large.\n- B: Powers of two.",
  );
  issue.updatedAt = linear.tick();
  let refusal: { code?: string } | undefined;
  try {
    await harness.behavior.callRpc("questions.answer", {
      issueId: issue.id,
      blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
    });
  } catch (error) {
    refusal = error as { code?: string };
  }

  const posts = linear.calls.filter((call) => call.startsWith("createComment"));
  assert.equal(posts.length, 0, `The stale choice posted new option text: ${issue.comments.at(-1)?.body}`);
  assert.equal(refusal?.code, "conflict");
});

test("review F2: a question arriving during the write remains open", async () => {
  const outcomes = [];
  for (const label of ["checkin", "needs-decision"]) {
    const { linear, harness, refresh } = await setup();
    const issue = linear.addIssue("TEAM-1", [label]);
    linear.post(issue, "q1", QUESTIONS);
    const shown = await refresh();

    const createComment = linear.createComment.bind(linear);
    linear.createComment = async (args) => {
      // Another agent writes after the fresh read and before this write lands.
      linear.post(issue, "q-unseen", QUESTIONS.replace("Which scale do estimates use?", "May I delete the project?"));
      return createComment(args);
    };
    await harness.behavior.callRpc("questions.answer", {
      issueId: issue.id,
      blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
    });

    const after = await refresh();
    outcomes.push({
      label,
      unseenStillOpen: after.issues.some((open) => open.blocks.some((block) => block.commentId === "q-unseen")),
      labelStillPresent: issue.labels.some((current) => current.name === label),
    });
  }
  assert.deepEqual(outcomes, [
    { label: "checkin", unseenStillOpen: true, labelStillPresent: true },
    { label: "needs-decision", unseenStillOpen: true, labelStillPresent: true },
  ]);
});

test("review F3: the CLI refuses an answer after the listed block is replaced", async () => {
  const { linear, harness } = await setup();
  const issue = linear.addIssue("TEAM-1", ["needs-decision"]);
  linear.post(issue, "q1", QUESTIONS);
  const listed = await harness.behavior.runCli(["questions", "--json"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal((JSON.parse(listed.stdout) as Snapshot).issues[0]?.blocks[0]?.commentId, "q1");
  const listedBlock = (JSON.parse(listed.stdout) as Snapshot).issues[0]!.blocks[0]!;

  const text = "Q1. A\nQ2. The cells.";
  harness.inspection.sdk.stub("files.read", async () => ({
    content: text, contentEncoding: "utf8", path: "/work/answer.md", sha256: "x", sizeBytes: text.length,
  }));
  linear.post(issue, "q2", QUESTIONS.replace("Which scale do estimates use?", "May I delete the project?"));
  const answer = await harness.behavior.runCli([
    "answer", "TEAM-1", "--block", `${listedBlock.commentId}@${listedBlock.revision}`, "--text-file", "/work/answer.md",
  ]);

  const posts = linear.calls.filter((call) => call.startsWith("createComment"));
  assert.equal(posts.length, 0, `The CLI accepted an answer to q1 for its replacement q2: ${JSON.stringify(answer)}`);
  assert.equal(answer.exitCode, 1);
});

test("review F4: header validation does not expose a secret pasted with a newline", async () => {
  const key = "lin_api_review_secret\nsecond_line";
  const host = createFakePluginHost({ pluginId: "sgc-steward", settings: { linearApiKey: key, teamKey: "TEAM" } });
  await createSgcStewardPlugin({
    createClient: (apiKey) => createLinearClient({
      apiKey,
      fetch: async (_url, init) => {
        // Exercise native header validation without making a network request.
        new Headers(init.headers);
        throw new Error("network disabled in this test");
      },
    }),
  })(host.bb);
  const snapshot = await host.harness.behavior.callRpc("questions.refresh", null) as Snapshot;
  assert.ok(snapshot.error, "the malformed key must fail locally");
  assert.deepEqual({
    exposedToFrontend: snapshot.error.includes("lin_api_review_secret"),
    exposedInLogs: host.harness.inspection.logEntries.some((entry) => entry.message.includes("lin_api_review_secret")),
  }, {
    exposedToFrontend: false,
    exposedInLogs: false,
  });
});

test("review F5: aborting a stalled poll releases the service and queued answers", async () => {
  const { linear, harness, refresh } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  const shown = await refresh();

  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  let requestIsAbortable = false;
  linear.listQuestionIssues = async (_teamKey, signal?: AbortSignal) => {
    requestIsAbortable = signal !== undefined;
    entered();
    return new Promise<LinearIssue[]>((resolve) => {
      release = () => resolve([]);
      if (signal?.aborted) release();
      else signal?.addEventListener("abort", release, { once: true });
    });
  };

  const service = harness.behavior.runService("poller");
  await started;
  let answerSettled = false;
  const answer = harness.behavior.callRpc("questions.answer", {
    issueId: issue.id,
    blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
  }).finally(() => { answerSettled = true; });
  let observed;
  try {
    service.controller.abort();
    const pollerStopped = await Promise.race([
      service.done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    observed = { requestIsAbortable, pollerStopped, answerStillQueued: !answerSettled };
  } finally {
    // Release the fake even on failure so this reproduction cannot hang the runner.
    release();
    await Promise.all([service.done, answer]);
  }
  assert.deepEqual(observed, { requestIsAbortable: true, pollerStopped: true, answerStillQueued: false });
});

test("review F6: stale pages cannot answer completed or canceled issues", async () => {
  const outcomes = [];
  for (const terminal of ["completed", "canceled"]) {
    const { linear, harness, refresh } = await setup();
    const issue = Object.assign(linear.addIssue("TEAM-1", ["needs-decision"]), { state: { type: "started" } });
    const listQuestionIssues = linear.listQuestionIssues.bind(linear);
    // Terminal states leave the list while direct issue reads still find them.
    linear.listQuestionIssues = async (teamKey) =>
      ["completed", "canceled"].includes(issue.state.type) ? [] : listQuestionIssues(teamKey);
    linear.post(issue, "q1", QUESTIONS);
    const shown = await refresh();
    assert.equal(shown.issues.length, 1);

    issue.state.type = terminal;
    issue.updatedAt = linear.tick();
    assert.deepEqual(await linear.listQuestionIssues("TEAM"), []);
    assert.ok(await linear.getIssue(issue.id));
    try {
      await harness.behavior.callRpc("questions.answer", {
        issueId: issue.id,
        blocks: [{ blockId: "q1", revision: revisionOf(shown, "q1"), answers: [{ number: 1, option: "A", text: "" }] }],
      });
    } catch (error) {
      assert.equal((error as { code?: string }).code, "conflict");
    }
    outcomes.push({
      state: terminal,
      writes: linear.calls.filter((call) => call.startsWith("createComment")).length,
      labelStillPresent: issue.labels.some((label) => label.name === "needs-decision"),
    });
  }
  assert.deepEqual(outcomes, [
    { state: "completed", writes: 0, labelStillPresent: true },
    { state: "canceled", writes: 0, labelStillPresent: true },
  ]);
});

test("review F7: the questions CLI fails when the issue comments cannot be read", async () => {
  const { linear, harness, refresh } = await setup();
  const issue = linear.addIssue("TEAM-1", ["checkin"]);
  linear.post(issue, "q1", QUESTIONS);
  assert.equal((await refresh()).issues.length, 1);

  issue.updatedAt = linear.tick();
  linear.listComments = async () => { throw new LinearError("http", "Linear answered HTTP 502."); };
  const result = await harness.behavior.runCli(["questions", "--json"]);
  const snapshot = JSON.parse(result.stdout) as Snapshot;
  assert.equal(snapshot.issueErrors.length, 1, "the issue's comment read must fail");
  assert.equal(snapshot.issueErrors[0]?.identifier, "TEAM-1");
  assert.equal(result.exitCode, 1, "a failed comment read must not be reported as a successful questions check");
});
