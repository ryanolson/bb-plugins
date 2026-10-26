import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizationHeader, createLinearClient, keyProblem, LinearError, redact, type FetchLike } from "./linear.ts";

const KEY = "lin_api_test_not_a_real_key";

interface Call {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

/** A fake Linear endpoint: each call takes the next scripted response. */
function fakeLinear(responses: Array<{ status?: number; json?: unknown; text?: string } | Error>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, headers: init.headers, query: body.query, variables: body.variables });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const text = next.text ?? JSON.stringify(next.json);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { calls, client: createLinearClient({ apiKey: KEY, fetch }) };
}

function commentNode(id: string, createdAt: string, body: string, extra: Record<string, unknown> = {}) {
  return { id, body, createdAt, parentId: null, user: { id: "u1" }, botActor: null, ...extra };
}

function commentsPage(nodes: unknown[], hasNextPage: boolean, endCursor: string | null = null) {
  return { json: { data: { issue: { comments: { nodes, pageInfo: { hasNextPage, endCursor } } } } } };
}

test("a personal API key goes in bare, an OAuth token as Bearer", () => {
  assert.equal(authorizationHeader(" lin_api_abc\n"), "lin_api_abc");
  assert.equal(authorizationHeader("lin_oauth_abc"), "Bearer lin_oauth_abc");
});

test("a key with spaces or control characters is refused before any request, without echoing it", async () => {
  for (const bad of ["lin_api_secret\nsecond", "lin_api_sec ret", "lin_api_secret\u0000", "lin_api_sécret"]) {
    assert.match(keyProblem(bad) ?? "", /spaces, line breaks, or other control characters/);
    let fetched = false;
    const client = createLinearClient({
      apiKey: bad,
      fetch: async () => {
        fetched = true;
        throw new Error("unreachable");
      },
    });
    await assert.rejects(client.listQuestionIssues("TEAM"), (error: unknown) => {
      assert.ok(error instanceof LinearError);
      assert.equal(error.kind, "auth");
      assert.ok(!error.message.includes("secret") && !error.message.includes("sec ret") && !error.message.includes("sécret"), error.message);
      return true;
    });
    assert.equal(fetched, false);
  }
  assert.equal(keyProblem(" lin_api_fine\n"), null, "outer whitespace is trimmed");
});

test("error text from the network or from Linear never carries the key", async () => {
  const echo: FetchLike = async (_url, init) => {
    throw new Error(`header rejected: ${init.headers.authorization} and ${JSON.stringify(init.headers.authorization)}`);
  };
  await assert.rejects(createLinearClient({ apiKey: KEY, fetch: echo }).listQuestionIssues("TEAM"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.ok(!error.message.includes(KEY), error.message);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
  const { client } = fakeLinear([{ json: { errors: [{ message: `bad token ${KEY} or lin_api_someoneelse` }] } }]);
  await assert.rejects(client.listQuestionIssues("TEAM"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.ok(!error.message.includes(KEY) && !error.message.includes("lin_api_someoneelse"), error.message);
    return true;
  });
  assert.equal(redact(`a ${KEY} b`, [KEY]), "a [redacted] b");
});

test("a request that hangs times out, and one the caller stops says so", async () => {
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
    });
  const slow = createLinearClient({ apiKey: KEY, fetch: hang, requestTimeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(slow.listQuestionIssues("TEAM"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.kind, "timeout");
    assert.match(error.message, /did not answer within/);
    return true;
  });
  assert.ok(Date.now() - started < 2_000);

  const stop = new AbortController();
  const stopped = createLinearClient({ apiKey: KEY, fetch: hang }).listComments("issue-1", stop.signal);
  stop.abort();
  await assert.rejects(stopped, (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.kind, "aborted");
    return true;
  });
});

test("question issues: one team, both labels, open states, every page", async () => {
  const issue = (id: string, labels: string[]) => ({
    id,
    identifier: `TEAM-${id}`,
    title: `Issue ${id}`,
    url: `https://linear.example/${id}`,
    updatedAt: "2026-01-05T10:00:00.000Z",
    team: { key: "TEAM" },
    labels: { nodes: labels.map((name) => ({ id: `label-${name}`, name })) },
  });
  const { calls, client } = fakeLinear([
    { json: { data: { issues: { nodes: [issue("1", ["checkin"])], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } },
    { json: { data: { issues: { nodes: [issue("2", ["needs-decision", "area"])], pageInfo: { hasNextPage: false, endCursor: null } } } } },
  ]);
  const issues = await client.listQuestionIssues("TEAM");
  assert.deepEqual(
    issues.map((found) => [found.identifier, found.labels.map((label) => label.name)]),
    [
      ["TEAM-1", ["checkin"]],
      ["TEAM-2", ["needs-decision", "area"]],
    ],
  );
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql");
  assert.equal(calls[0]?.headers.authorization, KEY);
  assert.deepEqual(calls[0]?.variables, { teamKey: "TEAM", labels: ["checkin", "needs-decision"], after: null });
  assert.equal(calls[1]?.variables.after, "c1");
  assert.match(calls[0]?.query ?? "", /state: \{ type: \{ nin: \["completed", "canceled"\] \} \}/);
});

test("comments: users and bots are told apart, replies keep their parent", async () => {
  const { client } = fakeLinear([
    commentsPage(
      [
        commentNode("c1", "2026-01-05T10:00:00.000Z", "[agent:codex thr_x] Questions"),
        commentNode("c2", "2026-01-05T10:01:00.000Z", "linked", { user: null, botActor: { type: "github" } }),
        commentNode("c3", "2026-01-05T10:02:00.000Z", "A", { parentId: "c1" }),
        commentNode("c4", "2026-01-05T10:03:00.000Z", "from an app", { botActor: { type: "oauthClient" } }),
      ],
      false,
    ),
  ]);
  const comments = await client.listComments("issue-1");
  assert.deepEqual(
    comments.map((comment) => [comment.id, comment.author, comment.parentId]),
    [
      ["c1", "user", null],
      ["c2", "bot", null],
      ["c3", "user", "c1"],
      ["c4", "bot", null],
    ],
  );
});

test("comments come newest first, so paging stops once a page holds an answer", async () => {
  const { calls, client } = fakeLinear([
    commentsPage(
      [
        commentNode("c4", "2026-01-05T10:04:00.000Z", "[agent:codex thr_x] Questions"),
        commentNode("c3", "2026-01-05T10:03:00.000Z", "[agent:codex thr_x] Run"),
      ],
      true,
      "p1",
    ),
    commentsPage(
      [
        commentNode("c2", "2026-01-05T10:02:00.000Z", "Use A."),
        commentNode("c1", "2026-01-05T10:01:00.000Z", "[agent:codex thr_x] Questions"),
      ],
      true,
      "p2",
    ),
  ]);
  const comments = await client.listComments("issue-1");
  assert.deepEqual(comments.map((comment) => comment.id), ["c4", "c3", "c2", "c1"]);
  assert.equal(calls.length, 2, "the third page is older than the answer and is never fetched");
  assert.equal(calls[1]?.variables.after, "p1");
});

test("comments that come oldest first are read to the end", async () => {
  const { calls, client } = fakeLinear([
    commentsPage(
      [
        commentNode("c1", "2026-01-05T10:01:00.000Z", "Use A."),
        commentNode("c2", "2026-01-05T10:02:00.000Z", "[agent:codex thr_x] Questions"),
      ],
      true,
      "p1",
    ),
    commentsPage([commentNode("c3", "2026-01-05T10:03:00.000Z", "[agent:codex thr_x] Questions")], false),
  ]);
  assert.equal((await client.listComments("issue-1")).length, 3);
  assert.equal(calls.length, 2);
});

test("paging stops at the page limit", async () => {
  const pages = Array.from({ length: 5 }, (_, page) =>
    commentsPage([commentNode(`c${page}`, `2026-01-05T10:0${page}:00.000Z`, "[agent:codex thr_x] Run")], true, `p${page}`),
  );
  const fetch: FetchLike = async () => {
    const next = pages.shift()!;
    return { ok: true, status: 200, text: async () => JSON.stringify(next.json) };
  };
  const client = createLinearClient({ apiKey: KEY, fetch, maxCommentPages: 3 });
  await assert.rejects(client.listComments("issue-1"), /more than 3 pages of comments/);
});

test("an issue that does not exist is null", async () => {
  const { client } = fakeLinear([
    { json: { data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INVALID_INPUT" } }] } },
  ]);
  assert.equal(await client.getIssue("TEAM-404"), null);
});

test("an answer is posted with the comment id chosen by the caller", async () => {
  const { calls, client } = fakeLinear([{ json: { data: { commentCreate: { success: true, comment: { id: "new-1" } } } } }]);
  const id = await client.createComment({ issueId: "issue-1", body: "Q1. A", commentId: "new-1" });
  assert.equal(id, "new-1");
  assert.deepEqual(calls[0]?.variables, { input: { id: "new-1", issueId: "issue-1", body: "Q1. A" } });
});

test("removing a label reports failure", async () => {
  const { calls, client } = fakeLinear([
    { json: { data: { issueRemoveLabel: { success: true } } } },
    { json: { data: { issueRemoveLabel: { success: false } } } },
  ]);
  await client.removeLabel({ issueId: "issue-1", labelId: "label-1" });
  assert.deepEqual(calls[0]?.variables, { id: "issue-1", labelId: "label-1" });
  await assert.rejects(client.removeLabel({ issueId: "issue-1", labelId: "label-1" }), /Linear did not remove the label/);
});

test("failures become LinearError with a kind, and never carry the key", async () => {
  const cases: Array<[Parameters<typeof fakeLinear>[0][number], string, RegExp]> = [
    [{ status: 401, json: { errors: [{ message: "Authentication required" }] } }, "auth", /rejected the API key \(HTTP 401\)/],
    [{ status: 400, json: { errors: [{ message: "no", extensions: { code: "AUTHENTICATION_ERROR" } }] } }, "auth", /rejected the API key/],
    [{ status: 429, text: "slow down" }, "rate-limit", /rate limit/],
    [{ json: { errors: [{ message: "limit", extensions: { code: "RATELIMITED" } }] } }, "rate-limit", /rate limit/],
    [{ json: { errors: [{ message: "Field 'x' is not defined" }] } }, "graphql", /Field 'x' is not defined/],
    [{ status: 502, text: "<html>bad gateway</html>" }, "http", /HTTP 502/],
    [{ text: "not json" }, "http", /not JSON/],
    [new Error("socket hang up"), "network", /could not reach Linear: socket hang up/],
  ];
  for (const [response, kind, message] of cases) {
    const { client } = fakeLinear([response]);
    await assert.rejects(client.listQuestionIssues("TEAM"), (error: unknown) => {
      assert.ok(error instanceof LinearError, String(error));
      assert.equal(error.kind, kind);
      assert.match(error.message, message);
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  }
});
