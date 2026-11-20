// The thread lifecycle service: every five minutes it reads every bb thread,
// finds each one's Linear issue, works out its state and the cache expiry, and
// decides what should happen to it (lib/lifecycle.ts). The last snapshot and a
// log of the decisions are kept in SQLite.
//
// In observe mode, which is the only mode so far, it takes no action: a
// decision is logged with its inputs and reason, and the result is "observed".
//
// Everything runs under this service's own lock, apart from the plugin's one
// Linear lock: it reads Linear but never writes it, and it shares no state with
// the question poll.

import type Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { LifecycleIssue, LinearClient } from "./lib/linear.ts";
import {
  MINUTE,
  cacheExpiry,
  classify,
  decide,
  formatExpiresIn,
  issueFor,
  titleIdentifier,
  type Decision,
  type EnvFacts,
  type IssueFacts,
  type IssueWithComments,
  type LifecycleContext,
  type ThreadFacts,
  type ThreadState,
} from "./lib/lifecycle.ts";

type Sdk = BbPluginApi["sdk"];

/** How often the service reads every thread. */
export const THREADS_POLL_MS = 5 * MINUTE;
/** Linear issues changed in this long are read for their claims. */
const ISSUE_LOOKBACK_MS = 30 * 24 * 60 * MINUTE;
const THREADS_PAGE = 200;
const MAX_PAGES = 50;
const READ_CONCURRENCY = 6;
const MAX_LOG_LIMIT = 500;

/** Appended to the plugin's migration list; never reorder or edit. */
export const THREADS_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS thread_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    taken_at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    thread_title TEXT NOT NULL,
    cycle INTEGER NOT NULL,
    decision TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    inputs TEXT NOT NULL,
    result TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS thread_decisions_by_thread ON thread_decisions (thread_id, cycle, id)`,
];

export type DecisionResult = "observed" | "done" | "failed";

export interface ThreadRowView {
  id: string;
  title: string;
  state: ThreadState;
  stateReason: string;
  issue: { identifier: string; url: string; stateName: string } | null;
  provider: string;
  model: string | null;
  hostId: string | null;
  environmentId: string | null;
  usedTokens: number | null;
  contextWindow: number | null;
  lastActivityAt: number;
  expiresAt: number;
  expiresSource: "offer" | "provider-table" | "override";
  /** Text for the countdown as of the snapshot; callers recompute from `expiresAt`. */
  expiresIn: string;
  inWindow: boolean;
  decision: Decision;
  reason: string;
}

export interface ThreadsView {
  checkedAt: number;
  mode: "observe" | "act";
  linearError: string | null;
  threads: ThreadRowView[];
}

export interface DecisionRow {
  id: number;
  at: number;
  threadId: string;
  threadTitle: string;
  decision: Decision;
  state: ThreadState;
  reason: string;
  result: DecisionResult;
  inputs: Record<string, unknown>;
}

export interface ThreadsSettings {
  stewardThread: string | undefined;
  teamKey: string;
  cacheLifeOverrides: Readonly<Record<string, number>>;
}

export interface ThreadsDeps {
  db: Database.Database;
  sdk: Sdk;
  now(): number;
  settings(): Promise<ThreadsSettings>;
  /** A Linear client and the team to read, or null when no key is set. Errors come back without the key. */
  linear(): Promise<{ client: LinearClient; teamKey: string } | null>;
  log(text: string): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `work` over `items`, a few at a time, keeping the results in order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const ACTIVE = new Set(["active", "starting", "stopping", "pending", "provisioning"]);

function withComments(issue: LifecycleIssue): IssueWithComments {
  return {
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    stateName: issue.state?.name ?? "unknown",
    stateType: issue.state?.type ?? "unknown",
    labels: issue.labels,
    updatedAt: Date.parse(issue.updatedAt),
    comments: issue.comments.map((comment) => ({ body: comment.body, createdAt: Date.parse(comment.createdAt) })),
  };
}

const asFacts = ({ comments: _comments, ...facts }: IssueWithComments): IssueFacts => facts;

/** What `environments.status` says about a checkout, as the safety rules read it. */
export async function readEnv(sdk: Sdk, environmentId: string): Promise<EnvFacts> {
  try {
    const status = await sdk.environments.status({ environmentId });
    if (status.outcome === "not_applicable") return { known: true, clean: true, ahead: false, branch: null, head: null, detail: null };
    if (status.outcome === "unavailable") return { known: false, clean: false, ahead: false, branch: null, head: null, detail: status.failure.message };
    const { workspace } = status;
    const tree = workspace.workingTree.state;
    const merge = workspace.mergeBase;
    const checkout = workspace.checkout;
    return {
      known: true,
      clean: tree === "clean" || tree === "committed_unmerged",
      ahead: merge !== null && ((merge.aheadCount ?? 0) > 0 || merge.hasCommittedUnmergedChanges === true),
      branch: checkout.kind === "branch" ? checkout.branchName : (workspace.branch?.currentBranch ?? null),
      head: checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null,
      detail: null,
    };
  } catch (error) {
    return { known: false, clean: false, ahead: false, branch: null, head: null, detail: message(error) };
  }
}

export function createThreads(deps: ThreadsDeps) {
  const { db, sdk, now } = deps;
  const usage = new Map<string, { key: string; used: number | null; window: number | null; offer: number | null; cost: ThreadFacts["cost"] }>();
  const models = new Map<string, string>();

  const loadSnapshot = db.prepare("SELECT body FROM thread_snapshot WHERE id = 1");
  const saveSnapshot = db.prepare("INSERT INTO thread_snapshot (id, taken_at, body) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET taken_at = excluded.taken_at, body = excluded.body");
  const lastDecision = db.prepare("SELECT decision, reason FROM thread_decisions WHERE thread_id = ? AND cycle = ? ORDER BY id DESC LIMIT 1");
  const insertDecision = db.prepare(
    "INSERT INTO thread_decisions (at, thread_id, thread_title, cycle, decision, state, reason, inputs, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const readDecisions = db.prepare("SELECT id, at, thread_id, thread_title, decision, state, reason, inputs, result FROM thread_decisions ORDER BY id DESC LIMIT ?");

  let tail: Promise<unknown> = Promise.resolve();
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  }

  async function listThreads() {
    const rows: Awaited<ReturnType<Sdk["threads"]["list"]>> = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await sdk.threads.list({ includeHidden: true, limit: THREADS_PAGE, offset: page * THREADS_PAGE });
      rows.push(...batch);
      if (batch.length < THREADS_PAGE) break;
    }
    return rows.filter((row) => row.archivedAt === null && row.deletedAt === null);
  }

  async function readUsage(thread: { id: string; updatedAt: number }) {
    const key = `${thread.updatedAt}`;
    const cached = usage.get(thread.id);
    if (cached !== undefined && cached.key === key) return cached;
    let entry: NonNullable<ReturnType<typeof usage.get>> = { key, used: null, window: null, offer: null, cost: null };
    try {
      const { usage: found } = await sdk.threads.context({ threadId: thread.id });
      if (found !== null) {
        entry = {
          key,
          used: found.usedTokens,
          window: found.modelContextWindow,
          offer: found.compactionOfferAt === undefined ? null : Date.parse(found.compactionOfferAt),
          cost: found.cost === undefined ? null : { amount: found.cost.amount, currency: found.cost.currency },
        };
      }
    } catch (error) {
      deps.log(`could not read the context of ${thread.id}: ${message(error)}`);
      return entry;
    }
    usage.set(thread.id, entry);
    return entry;
  }

  async function readModel(threadId: string): Promise<string | null> {
    const known = models.get(threadId);
    if (known !== undefined) return known;
    try {
      const options = await sdk.threads.defaultExecutionOptions({ threadId });
      if (options === null) return null;
      models.set(threadId, options.model);
      return options.model;
    } catch {
      return null;
    }
  }

  /** The count of queued turns and the creation time of the oldest; read only for a thread bb says has queued work. */
  async function readQueue(thread: { id: string; queuedWork: string }): Promise<{ count: number; oldest: number | null }> {
    if (thread.queuedWork === "none") return { count: 0, oldest: null };
    try {
      const rows = await sdk.threads.queuedMessages.list({ threadId: thread.id });
      return { count: rows.length, oldest: rows.length === 0 ? null : Math.min(...rows.map((row) => row.createdAt)) };
    } catch (error) {
      deps.log(`could not read the queue of ${thread.id}: ${message(error)}`);
      return { count: 1, oldest: null };
    }
  }

  /** Every issue Linear knows that changed lately, with the claims in them; or why it could not be read. */
  async function readIssues(): Promise<{ client: LinearClient; issues: IssueWithComments[]; teamKey: string } | { error: string }> {
    let linear: Awaited<ReturnType<ThreadsDeps["linear"]>>;
    try {
      linear = await deps.linear();
    } catch (error) {
      return { error: message(error) };
    }
    if (linear === null) return { error: "The Linear API key is not set, so threads have no issues." };
    try {
      const since = new Date(now() - ISSUE_LOOKBACK_MS).toISOString();
      const issues = (await linear.client.listLifecycleIssues(linear.teamKey, since)).map(withComments);
      return { client: linear.client, issues, teamKey: linear.teamKey };
    } catch (error) {
      return { error: `Could not read Linear: ${message(error)}` };
    }
  }

  function inputsOf(facts: ThreadFacts, issue: IssueFacts | null | undefined, expiresAt: number, source: string): Record<string, unknown> {
    return {
      issue: issue?.identifier ?? null,
      issueState: issue?.stateName ?? null,
      status: facts.status,
      providerId: facts.providerId,
      model: facts.model,
      usedTokens: facts.usedTokens,
      queuedCount: facts.queuedCount,
      childWorking: facts.childWorking,
      lastActivityAt: facts.lastActivityAt,
      expiresAt,
      expirySource: source,
      env: facts.env === undefined ? null : facts.env,
    };
  }

  /** Record a decision once per cache life; again only when the decision or its reason changes. */
  function record(row: ThreadRowView, facts: ThreadFacts, issue: IssueFacts | null | undefined, result: DecisionResult): void {
    if (row.decision === "none") return;
    const last = lastDecision.get(row.id, row.expiresAt) as { decision: string; reason: string } | undefined;
    if (last !== undefined && last.decision === row.decision && last.reason === row.reason) return;
    insertDecision.run(
      now(),
      row.id,
      row.title,
      row.expiresAt,
      row.decision,
      row.state,
      row.reason,
      JSON.stringify(inputsOf(facts, issue, row.expiresAt, row.expiresSource)),
      result,
    );
  }

  async function gather(): Promise<ThreadsView> {
    const settings = await deps.settings();
    const at = now();
    const listed = await listThreads();
    const childrenOf = new Map<string, string[]>();
    for (const row of listed) {
      if (row.parentThreadId !== null) childrenOf.set(row.parentThreadId, [...(childrenOf.get(row.parentThreadId) ?? []), row.id]);
    }
    const byId = new Map(listed.map((row) => [row.id, row]));
    const working = new Map<string, boolean>();
    const descendantWorking = (id: string, seen: Set<string> = new Set()): boolean => {
      const known = working.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return false;
      seen.add(id);
      const result = (childrenOf.get(id) ?? []).some((child) => ACTIVE.has(byId.get(child)?.status ?? "") || descendantWorking(child, seen));
      working.set(id, result);
      return result;
    };

    const linear = await readIssues();
    const issueCache = new Map<string, IssueWithComments | null>();
    const issueOf = async (thread: { id: string; title: string }): Promise<IssueFacts | null | undefined> => {
      if ("error" in linear) return undefined;
      const found = issueFor(thread, linear.issues, linear.teamKey);
      if (found !== null) return asFacts(found);
      const identifier = titleIdentifier(thread.title, linear.teamKey);
      if (identifier === null) return null;
      // An issue older than the lookback: ask for it by name.
      if (!issueCache.has(identifier)) {
        try {
          const one = await linear.client.getLifecycleIssue(identifier);
          issueCache.set(identifier, one === null ? null : withComments(one));
        } catch {
          return undefined;
        }
      }
      const older = issueCache.get(identifier);
      return older === undefined || older === null ? null : asFacts(older);
    };

    const rows = await mapLimit(listed, READ_CONCURRENCY, async (thread): Promise<ThreadRowView> => {
      const [used, model, queue, issue] = await Promise.all([readUsage(thread), readModel(thread.id), readQueue(thread), issueOf({ id: thread.id, title: thread.title ?? thread.titleFallback ?? thread.id })]);
      const facts: ThreadFacts = {
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? thread.id,
        status: thread.status,
        parentThreadId: thread.parentThreadId,
        providerId: thread.providerId,
        model,
        lastActivityAt: thread.updatedAt,
        pinned: thread.pinnedAt !== null,
        usedTokens: used.used,
        contextWindow: used.window,
        compactionOfferAt: used.offer,
        cost: used.cost,
        queuedCount: queue.count,
        oldestQueuedAt: queue.oldest,
        // Background agents, commands, and workflows count as children at work.
        childWorking: descendantWorking(thread.id) || thread.activity.activeBackgroundAgentCount + thread.activity.activeBackgroundCommandCount + thread.activity.activeWorkflowCount > 0,
        environmentId: thread.environmentId,
        hostId: thread.environmentHostId ?? null,
      };
      const ctx: LifecycleContext = { now: at, issue, stewardThread: settings.stewardThread };
      const classification = classify(facts, ctx);
      const expiry = cacheExpiry(facts, settings.cacheLifeOverrides);
      let verdict = decide(facts, classification, ctx, settings.cacheLifeOverrides);
      // An archive needs the checkout's state: read it only for a thread that could be archived now.
      if ((classification.state === "done" || classification.state === "parked") && verdict.inWindow) {
        facts.env = thread.environmentId === null ? null : await readEnv(sdk, thread.environmentId);
        verdict = decide(facts, classification, ctx, settings.cacheLifeOverrides);
      }
      const row: ThreadRowView = {
        id: facts.id,
        title: facts.title,
        state: classification.state,
        stateReason: classification.reason,
        issue: issue === null || issue === undefined ? null : { identifier: issue.identifier, url: issue.url, stateName: issue.stateName },
        provider: facts.providerId,
        model: facts.model,
        hostId: facts.hostId,
        environmentId: facts.environmentId,
        usedTokens: facts.usedTokens,
        contextWindow: facts.contextWindow,
        lastActivityAt: facts.lastActivityAt,
        expiresAt: expiry.at,
        expiresSource: expiry.source,
        expiresIn: formatExpiresIn(expiry.at - at),
        inWindow: verdict.inWindow,
        decision: verdict.decision,
        reason: verdict.reason,
      };
      // Observe only: log the decision, take no action.
      record(row, facts, issue, "observed");
      return row;
    });
    rows.sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
    return { checkedAt: at, mode: "observe", linearError: "error" in linear ? linear.error : null, threads: rows };
  }

  /** Read every thread now, log the decisions, and keep the snapshot. */
  function refresh(): Promise<ThreadsView> {
    return locked(async () => {
      const view = await gather();
      saveSnapshot.run(view.checkedAt, JSON.stringify(view));
      return view;
    });
  }

  /** The last snapshot, with countdowns as of now; null before the first. */
  function cached(): ThreadsView | null {
    const row = loadSnapshot.get() as { body: string } | undefined;
    if (row === undefined) return null;
    const view = JSON.parse(row.body) as ThreadsView;
    const at = now();
    return { ...view, threads: view.threads.map((thread) => ({ ...thread, expiresIn: formatExpiresIn(thread.expiresAt - at) })) };
  }

  function decisions(limit: number): DecisionRow[] {
    const rows = readDecisions.all(Math.min(Math.max(limit, 1), MAX_LOG_LIMIT)) as Array<{
      id: number;
      at: number;
      thread_id: string;
      thread_title: string;
      decision: Decision;
      state: ThreadState;
      reason: string;
      inputs: string;
      result: DecisionResult;
    }>;
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      decision: row.decision,
      state: row.state,
      reason: row.reason,
      result: row.result,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    }));
  }

  return { refresh, cached, decisions };
}

export type ThreadsService = ReturnType<typeof createThreads>;

function tokens(count: number | null): string {
  if (count === null) return "-";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export function formatThreads(view: ThreadsView, now: number): string {
  const header = ["THREAD", "STATE", "ISSUE", "PROVIDER/MODEL", "TOKENS", "EXPIRES", "DECISION", "REASON"];
  const rows = view.threads.map((thread) => [
    `${thread.id} ${thread.title}`,
    thread.state,
    thread.issue?.identifier ?? "-",
    `${thread.provider}/${thread.model ?? "?"}`,
    tokens(thread.usedTokens),
    formatExpiresIn(thread.expiresAt - now),
    thread.decision,
    thread.reason,
  ]);
  const widths = header.map((name, column) => Math.min(Math.max(name.length, ...rows.map((row) => row[column]!.length)), column === 0 ? 48 : column === 7 ? 80 : 30));
  const line = (row: string[]) => row.map((text, column) => cell(text, widths[column]!)).join("  ").trimEnd();
  const lines = [line(header), ...rows.map(line)];
  lines.push("", `${view.threads.length} threads; mode ${view.mode}; read ${new Date(view.checkedAt).toISOString()}`);
  if (view.linearError !== null) lines.push(`Linear: ${view.linearError}`);
  return lines.join("\n");
}

export function formatDecisions(rows: DecisionRow[]): string {
  if (rows.length === 0) return "No decisions yet.";
  return rows
    .map((row) => `${new Date(row.at).toISOString()}  ${row.threadId}  ${row.decision}  ${row.result}  [${row.state}] ${row.reason}`)
    .join("\n");
}

/** `bb sgc threads [--json] [--cached]` and `bb sgc threads log [--limit N] [--json]`. */
export function threadsCommand(service: ThreadsService, now: () => number) {
  return cliCommand({
    summary: "List every thread with its lifecycle state, cache expiry, and the plugin's decision; `log` shows recent decisions",
    description:
      "Reads every thread from bb and its issue from Linear, then shows the state, the issue, provider and model, tokens, when the prompt cache expires, the decision, and why. `bb sgc threads log` shows the decisions made, newest first. In observe mode nothing is acted on. Exits 1 when bb could not be read.",
    positionals: [{ name: "action", description: "`log` to show the decision log; leave out to list threads", required: false }],
    options: {
      json: { type: "boolean", description: "Print machine-readable JSON" },
      cached: { type: "boolean", description: "Print the last snapshot without reading bb or Linear" },
      limit: { type: "string", description: "With `log`: how many decisions to show (default 20, at most 500)" },
    },
    async run(input) {
      const action = input.positionals.action;
      if (action !== undefined && action !== "log") throw new PluginCliError(`Unknown action "${action}".`, { code: "invalid", hint: "Use `bb sgc threads` or `bb sgc threads log`." });
      if (action === "log") {
        const raw = input.options.limit;
        const limit = raw === undefined ? 20 : Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
          throw new PluginCliError(`--limit takes a whole number from 1 to ${MAX_LOG_LIMIT}.`, { code: "invalid" });
        }
        const rows = service.decisions(limit);
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(rows) : formatDecisions(rows) };
      }
      let view: ThreadsView | null;
      if (input.options.cached) {
        view = service.cached();
        if (view === null) throw new PluginCliError("No snapshot yet.", { code: "no_snapshot", hint: "Run `bb sgc threads` without --cached." });
      } else {
        try {
          view = await service.refresh();
        } catch (error) {
          throw new PluginCliError(`Could not read bb: ${message(error)}`, { code: "bb_error" });
        }
      }
      return { exitCode: 0, stdout: input.options.json ? JSON.stringify(view) : formatThreads(view, now()) };
    },
  });
}
