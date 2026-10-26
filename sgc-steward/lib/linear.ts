// A small Linear GraphQL client: the reads and writes the steward panel needs.
//
// The API key stays inside this module's requests. Error messages never echo
// it, and they carry a kind so the server can tell "fix your key" from "try
// again later".

import type { LinearComment } from "./questions.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
export const CHECKIN_LABEL = "checkin";
export const DECISION_LABEL = "needs-decision";

export interface LinearIssue {
  /** UUID. */
  id: string;
  /** Like TEAM-123. */
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  teamKey: string;
  /** The workflow state's type: triage, backlog, unstarted, started, completed, or canceled. */
  state: { type: string } | null;
  labels: Array<{ id: string; name: string }>;
}

export type LinearErrorKind = "auth" | "rate-limit" | "graphql" | "http" | "network" | "timeout" | "aborted" | "limit";

export class LinearError extends Error {
  readonly kind: LinearErrorKind;
  constructor(kind: LinearErrorKind, message: string) {
    super(message);
    this.name = "LinearError";
    this.kind = kind;
  }
}

/** The part of `fetch` the client uses, so tests can stand in for Linear. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Linear takes a personal API key bare and an OAuth token as Bearer. A key
 * sent as Bearer is refused.
 */
export function authorizationHeader(apiKey: string): string {
  const key = apiKey.trim();
  return key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;
}

// Printable ASCII without spaces. Anything else is not a valid header value,
// and the runtime's error for an invalid header quotes the value.
const KEY_SHAPE = /^[\x21-\x7e]+$/;
const KEY_LIKE = /lin_(?:api|oauth)_[A-Za-z0-9_]+/g;

/** Why a key cannot be sent, or null. The message never contains the key. */
export function keyProblem(apiKey: string): string | null {
  return KEY_SHAPE.test(apiKey.trim())
    ? null
    : "The Linear API key may hold only printable ASCII: no spaces, line breaks, or other control characters. Set it again with `bb sgc key --api-key-stdin`.";
}

/** Text with every copy of the secrets, and anything shaped like a Linear key, blanked out. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let clean = text;
  for (const secret of secrets) {
    for (const form of new Set([secret, secret.trim(), JSON.stringify(secret).slice(1, -1)])) {
      if (form.length >= 8) clean = clean.split(form).join("[redacted]");
    }
  }
  return clean.replace(KEY_LIKE, "[redacted]");
}

// Nested page sizes stay small: Linear limits query complexity.
const ISSUE_FIELDS = `id identifier title url updatedAt team { key } state { type } labels(first: 50) { nodes { id name } }`;

export const ISSUES_QUERY = `query SgcQuestionIssues($teamKey: String!, $labels: [String!]!, $after: String) {
  issues(
    first: 50
    after: $after
    filter: {
      team: { key: { eq: $teamKey } }
      labels: { some: { name: { in: $labels } } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ISSUE_QUERY = `query SgcIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

const COMMENT_PAGE = 50;
const REPLY_PAGE = 20;
const COMMENT_FIELDS = `id body createdAt parentId user { id } botActor { type }`;

// Replies are read through each comment's children as well: the issue's
// comment connection is not documented to list them.
export const COMMENTS_QUERY = `query SgcIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: ${COMMENT_PAGE}, after: $after, orderBy: createdAt) {
      nodes {
        ${COMMENT_FIELDS}
        children(first: ${REPLY_PAGE}) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const CREATE_COMMENT_MUTATION = `mutation SgcPostAnswer($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

export const REMOVE_LABEL_MUTATION = `mutation SgcRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  team: { key: string } | null;
  state: { type: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
}

interface CommentFields {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  user: { id: string } | null;
  botActor: { type: string } | null;
}

interface CommentNode extends CommentFields {
  children?: { nodes: CommentFields[]; pageInfo: { hasNextPage: boolean } };
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string };
}

export interface LinearClient {
  /** Open issues of one team that carry the check-in or needs-decision label. */
  listQuestionIssues(teamKey: string, signal?: AbortSignal): Promise<LinearIssue[]>;
  /** One issue by UUID or identifier; null when Linear has no such issue. */
  getIssue(id: string, signal?: AbortSignal): Promise<LinearIssue | null>;
  /**
   * Every comment of one issue, threaded replies included, oldest first.
   * Reads every page whatever order Linear returns. Throws a "limit"
   * LinearError past the page cap or past one page of replies in a thread,
   * so the caller shows the issue as unreadable instead of guessing. `label`
   * names the issue in that message, like TEAM-12; it defaults to the id.
   */
  listComments(issueId: string, signal?: AbortSignal, label?: string): Promise<LinearComment[]>;
  /** Post a comment with an id the caller chose, so a retried post cannot duplicate it. */
  createComment(args: { issueId: string; body: string; commentId: string }, signal?: AbortSignal): Promise<string>;
  removeLabel(args: { issueId: string; labelId: string }, signal?: AbortSignal): Promise<void>;
}

export interface LinearClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  endpoint?: string;
  /** Pages of 50 comments read per issue before giving up. */
  maxCommentPages?: number;
  /** How long one request may take, reading the reply included. */
  requestTimeoutMs?: number;
}

function toIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    updatedAt: node.updatedAt,
    teamKey: node.team?.key ?? "",
    state: node.state === null ? null : { type: node.state.type },
    labels: node.labels.nodes.map((label) => ({ id: label.id, name: label.name })),
  };
}

function toComment(node: CommentFields): LinearComment {
  return {
    id: node.id,
    body: node.body,
    createdAt: node.createdAt,
    author: node.user === null || node.botActor !== null ? "bot" : "user",
    parentId: node.parentId,
  };
}

function firstMessage(errors: GraphQLError[]): string {
  return errors
    .map((error) => error.message ?? "unknown error")
    .join("; ")
    .slice(0, 300);
}

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const endpoint = options.endpoint ?? LINEAR_ENDPOINT;
  const maxCommentPages = options.maxCommentPages ?? 20;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const problem = keyProblem(options.apiKey);
  const authorization = problem === null ? authorizationHeader(options.apiKey) : null;
  const clean = (text: string) => redact(text, [options.apiKey]);

  async function request<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T | null; errors: GraphQLError[] }> {
    if (authorization === null) throw new LinearError("auth", problem!);
    if (signal?.aborted) throw new LinearError("aborted", "The request was stopped.");
    // A stalled request would hold the plugin's lock, so every request has
    // a deadline, and the caller can stop it.
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ query, variables }),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new LinearError("aborted", "The request was stopped.");
      if (deadline.aborted) throw new LinearError("timeout", `Linear did not answer within ${Math.ceil(requestTimeoutMs / 1000)} s.`);
      throw new LinearError("network", clean(`could not reach Linear: ${error instanceof Error ? error.message : String(error)}`));
    }
    let payload: { data?: T | null; errors?: GraphQLError[] } | null = null;
    try {
      payload = JSON.parse(text) as { data?: T | null; errors?: GraphQLError[] };
    } catch {
      payload = null;
    }
    const errors = payload?.errors ?? [];
    const codes = errors.map((error) => error.extensions?.code);
    if (response.status === 401 || response.status === 403 || codes.includes("AUTHENTICATION_ERROR")) {
      throw new LinearError("auth", `Linear rejected the API key (HTTP ${response.status}). Set a new one with \`bb sgc key --api-key-stdin\`.`);
    }
    if (response.status === 429 || codes.includes("RATELIMITED")) {
      throw new LinearError("rate-limit", "Linear's rate limit was hit; the next poll tries again.");
    }
    if (payload === null) {
      throw new LinearError("http", `Linear answered HTTP ${response.status} with a body that is not JSON.`);
    }
    if (!response.ok && errors.length === 0) {
      throw new LinearError("http", `Linear answered HTTP ${response.status}.`);
    }
    return { data: payload.data ?? null, errors };
  }

  async function query<T>(document: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const { data, errors } = await request<T>(document, variables, signal);
    if (errors.length > 0 || data === null) {
      throw new LinearError("graphql", clean(`Linear refused the request: ${errors.length > 0 ? firstMessage(errors) : "no data"}`));
    }
    return data;
  }

  return {
    async listQuestionIssues(teamKey, signal) {
      const issues: LinearIssue[] = [];
      let after: string | null = null;
      for (;;) {
        const data: { issues: { nodes: IssueNode[]; pageInfo: PageInfo } } = await query(
          ISSUES_QUERY,
          { teamKey, labels: [CHECKIN_LABEL, DECISION_LABEL], after },
          signal,
        );
        issues.push(...data.issues.nodes.map(toIssue));
        if (!data.issues.pageInfo.hasNextPage || data.issues.pageInfo.endCursor === null) return issues;
        after = data.issues.pageInfo.endCursor;
      }
    },

    async getIssue(id, signal) {
      const { data, errors } = await request<{ issue: IssueNode | null }>(ISSUE_QUERY, { id }, signal);
      if (errors.some((error) => /not found/i.test(error.message ?? ""))) return null;
      if (errors.length > 0) throw new LinearError("graphql", clean(`Linear refused the request: ${firstMessage(errors)}`));
      return data?.issue ? toIssue(data.issue) : null;
    },

    async listComments(issueId, signal, label = issueId) {
      const byId = new Map<string, LinearComment>();
      let after: string | null = null;
      for (let page = 1; ; page += 1) {
        const data: { issue: { comments: { nodes: CommentNode[]; pageInfo: PageInfo } } | null } = await query(
          COMMENTS_QUERY,
          { id: issueId, after },
          signal,
        );
        if (data.issue === null) throw new LinearError("graphql", `Linear has no issue ${issueId}`);
        for (const node of data.issue.comments.nodes) {
          byId.set(node.id, toComment(node));
          if (node.children?.pageInfo.hasNextPage) {
            throw new LinearError("limit", `A comment thread on ${label} has more than ${REPLY_PAGE} replies, so the plugin does not guess which questions are open.`);
          }
          for (const child of node.children?.nodes ?? []) byId.set(child.id, toComment(child));
        }
        const { hasNextPage, endCursor } = data.issue.comments.pageInfo;
        if (!hasNextPage || endCursor === null) {
          return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
        }
        if (page >= maxCommentPages) {
          throw new LinearError("limit", `${label} has more than ${maxCommentPages * COMMENT_PAGE} comments, so the plugin does not guess which questions are open.`);
        }
        after = endCursor;
      }
    },

    async createComment({ issueId, body, commentId }, signal) {
      const data: { commentCreate: { success: boolean; comment: { id: string } | null } } = await query(
        CREATE_COMMENT_MUTATION,
        { input: { id: commentId, issueId, body } },
        signal,
      );
      if (!data.commentCreate.success || data.commentCreate.comment === null) {
        throw new LinearError("graphql", "Linear did not create the comment.");
      }
      return data.commentCreate.comment.id;
    },

    async removeLabel({ issueId, labelId }, signal) {
      const data: { issueRemoveLabel: { success: boolean } } = await query(REMOVE_LABEL_MUTATION, { id: issueId, labelId }, signal);
      if (!data.issueRemoveLabel.success) throw new LinearError("graphql", "Linear did not remove the label.");
    },
  };
}
