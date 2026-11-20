import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearClient, type FetchLike } from "./linear.ts";
import { PANEL_TABS, tabBadges, tabOf, tabPath } from "./panel.ts";
import { appLink } from "./links.ts";
import { resumeComment, resumeMessage } from "./paused.ts";

function fakeLinear(responses: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: body.query, variables: body.variables });
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) };
  };
  return { calls, client: createLinearClient({ apiKey: "lin_api_test_not_a_real_key", fetch }) };
}

test("the Paused tab has its own route after Todos", () => {
  assert.deepEqual(PANEL_TABS.map((tab) => [tab.id, tab.label, tab.subPath]), [
    ["questions", "Questions", ""],
    ["todos", "Todos", "todos"],
    ["paused", "Paused", "paused"],
    ["hosts", "Hosts", "hosts"],
  ]);
  assert.equal(tabOf("paused"), "paused");
  assert.equal(tabOf("paused/anything"), "paused");
  assert.equal(tabPath("paused"), "paused");
});

test("the Paused badge counts paused issues and expired questions, and alerts on a failed read or send", () => {
  const base = { issues: [], asks: [], issueErrors: [], undelivered: [], unposted: [], todos: [], todoError: null, paused: [], expired: [], pausedError: null };
  assert.deepEqual(tabBadges(base).paused, { count: 0, alert: false });
  assert.deepEqual(tabBadges({ ...base, paused: [{}, {}], expired: [{}] }).paused, { count: 3, alert: false });
  assert.deepEqual(tabBadges({ ...base, pausedError: "no label" }).paused, { count: 0, alert: true });
  assert.deepEqual(tabBadges({ ...base, undelivered: [{ source: "resume" }] }).paused, { count: 0, alert: true });
  assert.deepEqual(tabBadges({ ...base, undelivered: [{ source: "expiry" }] }).questions, { count: 0, alert: true });
});

test("a Linear link opens the app: https://linear.app/<workspace>/<rest> becomes linear://<workspace>/<rest>", () => {
  assert.equal(appLink("https://linear.app/nvidia/issue/STRGT-1/some-title"), "linear://nvidia/issue/STRGT-1/some-title");
  assert.equal(appLink("https://linear.app/nvidia/project/operator-tooling-abc123/overview"), "linear://nvidia/project/operator-tooling-abc123/overview");
  assert.equal(appLink("https://linear.app/nvidia/issue/STRGT-1#comment-x?y=1"), "linear://nvidia/issue/STRGT-1#comment-x?y=1");
  for (const other of ["https://github.com/a/b", "https://linear.example/TEAM-1", "https://linear.app.evil.example/x/y", "http://linear.app/nvidia/issue/A-1", "linear://nvidia/issue/A-1", "not a url", ""]) {
    assert.equal(appLink(other), other, other);
  }
});

test("the Resume comment and the steward message", () => {
  assert.equal(resumeComment(null), "Resumed (from the SGC page)");
  assert.equal(resumeComment("Answer is in the issue."), "Resumed (from the SGC page)\n\nAnswer is in the issue.");
  assert.equal(resumeMessage("TEAM-1", "Fix it", null), "[sgc-steward] Resumed TEAM-1: Fix it");
  assert.equal(resumeMessage("TEAM-1", "Fix it", "Go."), "[sgc-steward] Resumed TEAM-1: Fix it\nGo.");
});

function pausedNode(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    identifier: `TEAM-${id}`,
    title: `Paused ${id}`,
    url: `https://linear.app/ws/issue/TEAM-${id}`,
    updatedAt,
    team: { key: "TEAM" },
    state: { id: "state-backlog", name: "Backlog", type: "backlog" },
    labels: { nodes: [{ id: "label-paused", name: "paused" }] },
    ...extra,
  };
}

test("paused issues: one team, the paused label, open states, every page, newest first", async () => {
  const { calls, client } = fakeLinear([
    { data: { issues: { nodes: [pausedNode("1", "2026-11-18T10:00:00.000Z")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
    { data: { issues: { nodes: [pausedNode("2", "2026-11-19T10:00:00.000Z")], pageInfo: { hasNextPage: false, endCursor: null } } } },
  ]);
  const issues = await client.listPausedIssues("TEAM");
  assert.deepEqual(issues.map((issue) => [issue.identifier, issue.state, issue.updatedAt]), [
    ["TEAM-2", { id: "state-backlog", name: "Backlog", type: "backlog" }, "2026-11-19T10:00:00.000Z"],
    ["TEAM-1", { id: "state-backlog", name: "Backlog", type: "backlog" }, "2026-11-18T10:00:00.000Z"],
  ]);
  assert.deepEqual(calls[0]?.variables, { teamKey: "TEAM", label: "paused", after: null });
  assert.equal(calls[1]?.variables.after, "c1");
  assert.match(calls[0]!.query, /labels: \{ some: \{ name: \{ eq: \$label \} \} \}/);
  assert.match(calls[0]!.query, /state: \{ type: \{ nin: \["completed", "canceled"\] \} \}/, "completed and canceled issues are not listed");
});

test("one issue is read as a paused issue by id, and one that does not exist is null", async () => {
  const { client } = fakeLinear([
    { data: { issue: pausedNode("7", "2026-11-19T10:00:00.000Z") } },
    { data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INVALID_INPUT" } }] },
  ]);
  assert.equal((await client.getPausedIssue("TEAM-7"))?.identifier, "TEAM-7");
  assert.equal(await client.getPausedIssue("TEAM-404"), null);
});

test("the team's Todo state is its unstarted state named Todo, else the first unstarted state", async () => {
  const { calls, client } = fakeLinear([
    { data: { workflowStates: { nodes: [{ id: "s-ready", name: "Ready", position: 3 }, { id: "s-todo", name: "todo", position: 4 }] } } },
    { data: { workflowStates: { nodes: [{ id: "s-b", name: "Ready", position: 5 }, { id: "s-a", name: "Queued", position: 2 }] } } },
    { data: { workflowStates: { nodes: [] } } },
  ]);
  assert.equal(await client.todoStateId("TEAM"), "s-todo");
  assert.equal(await client.todoStateId("TEAM"), "s-a");
  assert.equal(await client.todoStateId("TEAM"), null);
  assert.match(calls[0]!.query, /type: \{ eq: "unstarted" \}/);
});

test("the project list uses a filter accepted by Linear", async () => {
  const fetch: FetchLike = async (_url, init) => {
    const { query } = JSON.parse(init.body) as { query: string };
    const body = /accessibleTeams:\s*\{\s*key\s*:/.test(query)
      ? { errors: [{ message: 'Field "key" is not defined by type "TeamCollectionFilter".' }] }
      : { data: { projects: { nodes: [{ name: "Tools", status: { type: "started" } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const client = createLinearClient({ apiKey: "lin_api_test_not_a_real_key", fetch });
  assert.deepEqual(await client.listProjectNames("TEAM"), ["Tools"]);
});
