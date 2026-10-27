// Fixtures shared by the server tests: an in-memory Linear and a plugin
// set up on bb's fake plugin host.
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createSgcStewardPlugin } from "./server.ts";
import type { Snapshot } from "./lib/contract.ts";
import { HUMAN_LABEL, LinearError, TODO_LABEL, type LinearClient, type LinearIssue, type TodoIssue } from "./lib/linear.ts";
import type { LinearComment } from "./lib/questions.ts";

export const KEY = "lin_api_test_not_a_real_key";

export const QUESTIONS = [
  "[agent:claude-code thr_test1] Questions 2026-01-05",
  "Q1. Which scale do estimates use?",
  "- A (recommended): Powers of two.",
  "- B: Small, medium, large.",
  "Q2. Which project goes first?",
].join("\n");

export interface FakeIssue extends LinearIssue {
  state: { id: string; type: string } | null;
  description: string;
  assignedToMe: boolean;
  comments: LinearComment[];
}

/** An in-memory Linear with the client's surface and a call log. */
export class FakeLinear implements LinearClient {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  keys: string[] = [];
  /** "lost": the write lands but the response is lost. "dropped": it never lands. */
  createFaults: Array<"lost" | "dropped"> = [];
  createFaultKind: "network" | "timeout" = "network";
  removeLabelFaults: Array<"lost" | "dropped"> = [];
  /** The team's workflow states, as Linear lists them. */
  states = [
    { id: "state-started", name: "In Progress", type: "started" },
    { id: "state-done", name: "Done", type: "completed" },
  ];
  private clock = Date.parse("2026-01-05T10:00:00Z");

  tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  addIssue(identifier: string, labels: string[], teamKey = "TEAM", extra: Partial<Pick<FakeIssue, "description" | "assignedToMe" | "state">> = {}): FakeIssue {
    const issue: FakeIssue = {
      id: `uuid-${identifier}`,
      identifier,
      title: `Title of ${identifier}`,
      url: `https://linear.example/${identifier}`,
      updatedAt: this.tick(),
      teamKey,
      state: { id: "state-started", type: "started" },
      labels: labels.map((name) => ({ id: `label-${name}`, name })),
      description: "",
      assignedToMe: false,
      comments: [],
      ...extra,
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

  todo(issue: FakeIssue): TodoIssue {
    const { id, identifier, title, url, description, teamKey, labels, assignedToMe } = issue;
    return structuredClone({ id, identifier, title, url, description, teamKey, state: issue.state, labels, assignedToMe });
  }

  async listTodoIssues(teamKey: string) {
    this.calls.push(`listTodoIssues ${teamKey}`);
    return this.issues
      .filter((issue) => issue.teamKey === teamKey && issue.labels.some((label) => [TODO_LABEL, HUMAN_LABEL].includes(label.name)))
      .filter((issue) => issue.state?.type !== "completed" && issue.state?.type !== "canceled")
      .map((issue) => this.todo(issue));
  }

  async getTodoIssue(id: string) {
    this.calls.push(`getTodoIssue ${id}`);
    const issue = this.find(id);
    return issue === undefined ? null : this.todo(issue);
  }

  async doneStateId(teamKey: string) {
    this.calls.push(`doneStateId ${teamKey}`);
    return this.states.find((state) => state.type === "completed")?.id ?? null;
  }

  async setState({ issueId, stateId }: { issueId: string; stateId: string }) {
    this.calls.push(`setState ${issueId} ${stateId}`);
    const issue = this.find(issueId)!;
    const state = this.states.find((candidate) => candidate.id === stateId)!;
    issue.state = { id: state.id, type: state.type };
    issue.updatedAt = this.tick();
  }

  async addLabel({ issueId, labelId }: { issueId: string; labelId: string }) {
    this.calls.push(`addLabel ${issueId} ${labelId}`);
    const issue = this.find(issueId)!;
    if (!issue.labels.some((label) => label.id === labelId)) issue.labels.push({ id: labelId, name: labelId.replace(/^label-/, "") });
    issue.updatedAt = this.tick();
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

export interface Notice {
  id: string;
  source: "linear" | "ask" | "todo";
  label: string;
  questionCount: number;
  preview: string;
}

/**
 * The plugin on a fake host with a fake Linear. Thread sends are recorded in
 * `sends` and succeed; a test re-stubs `threads.send` to make them fail.
 */
export async function setup(options: { key?: string | null; postWindowMs?: number } = {}) {
  const linear = new FakeLinear();
  const factory = createSgcStewardPlugin({
    createClient: (apiKey) => {
      linear.keys.push(apiKey);
      return linear;
    },
    retryDelayMs: 0,
    ...(options.postWindowMs === undefined ? {} : { postWindowMs: options.postWindowMs }),
  });
  const settings: Record<string, string> = options.key === null ? { teamKey: "TEAM" } : { linearApiKey: options.key ?? KEY, teamKey: "TEAM" };
  const host = createFakePluginHost({ pluginId: "sgc-steward", settings });
  const { harness } = host;
  const sends: Array<{ threadId: string; mode: string; input: Array<{ type: string; text: string; mentions: unknown[] }> }> = [];
  harness.inspection.sdk.stub("threads.send", async (args: unknown) => {
    sends.push(args as (typeof sends)[number]);
    return {};
  });
  harness.inspection.sdk.stub("threads.get", async (args: unknown) => {
    const { threadId } = args as { threadId: string };
    return { id: threadId, title: `Title of ${threadId}`, titleFallback: null, environmentId: null, archivedAt: null, deletedAt: null };
  });
  await factory(host.bb);
  const refresh = async () => (await harness.behavior.callRpc("questions.refresh", null)) as Snapshot;
  const claim = async () => (await harness.behavior.callRpc("notifications.claim", null)) as { notifications: Notice[] };
  return { linear, harness, refresh, claim, sends, factory };
}

export function revisionOf(snapshot: Snapshot, blockId: string): string {
  for (const issue of snapshot.issues) for (const block of issue.blocks) if (block.commentId === blockId) return block.revision;
  assert.fail(`no open block ${blockId}`);
}

export async function rejection(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; code?: string };
  }
  assert.fail("expected a rejection");
}

