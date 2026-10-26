// A small Linear GraphQL client: the reads and writes the steward panel needs.
//
// The API key stays inside this module's requests. Error messages never echo
// it, and they carry a kind so the server can tell "fix your key" from "try
// again later".

import { commentRole, type LinearComment } from "./questions.ts";

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
  labels: Array<{ id: string; name: string }>;
}

export type LinearErrorKind = "auth" | "rate-limit" | "graphql" | "http" | "network";

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
  if (key.startsWith("Bearer ")) return key;
  return key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;
}

// Nested page sizes stay small: Linear limits query complexity.
const ISSUE_FIELDS = `id identifier title url updatedAt team { key } labels(first: 50) { nodes { id name } }`;

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

export const COMMENTS_QUERY = `query SgcIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 50, after: $after, orderBy: createdAt) {
      nodes { id body createdAt parentId user { id } botActor { type } }
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
  labels: { nodes: Array<{ id: string; name: string }> };
}

interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  user: { id: string } | null;
  botActor: { type: string } | null;
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
   * The comments of one issue, replies included, in the order Linear returns
   * them. Reads newest-first pages only until one holds an unsigned answer:
   * nothing older can be an open question.
   */
  listComments(issueId: string, signal?: AbortSignal): Promise<LinearComment[]>;
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
}

function toIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    updatedAt: node.updatedAt,
    teamKey: node.team?.key ?? "",
    labels: node.labels.nodes.map((label) => ({ id: label.id, name: label.name })),
  };
}

function toComment(node: CommentNode): LinearComment {
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
  const authorization = authorizationHeader(options.apiKey);

  async function request<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T | null; errors: GraphQLError[] }> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ query, variables }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new LinearError("network", `could not reach Linear: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
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
      throw new LinearError("graphql", `Linear refused the request: ${errors.length > 0 ? firstMessage(errors) : "no data"}`);
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
      if (errors.length > 0) throw new LinearError("graphql", `Linear refused the request: ${firstMessage(errors)}`);
      return data?.issue ? toIssue(data.issue) : null;
    },

    async listComments(issueId, signal) {
      const comments: LinearComment[] = [];
      let after: string | null = null;
      for (let page = 1; ; page += 1) {
        const data: { issue: { comments: { nodes: CommentNode[]; pageInfo: PageInfo } } | null } = await query(
          COMMENTS_QUERY,
          { id: issueId, after },
          signal,
        );
        if (data.issue === null) throw new LinearError("graphql", `Linear has no issue ${issueId}`);
        comments.push(...data.issue.comments.nodes.map(toComment));
        const { hasNextPage, endCursor } = data.issue.comments.pageInfo;
        if (!hasNextPage || endCursor === null) return comments;
        const newestFirst = comments.every(
          (comment, index) => index === 0 || Date.parse(comments[index - 1]!.createdAt) >= Date.parse(comment.createdAt),
        );
        if (newestFirst && comments.some((comment) => commentRole(comment) === "answer")) return comments;
        if (page >= maxCommentPages) {
          throw new LinearError("http", `issue ${issueId} has more than ${maxCommentPages} pages of comments since its last answer`);
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
