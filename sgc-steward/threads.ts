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
import { Refusal } from "./lib/refusal.ts";
import {
  type DecisionResult,
  type DecisionRow,
  type RowAction,
  type ThreadRowView,
  type ThreadsView,
  tokenCount,
} from "./lib/threads-view.ts";
import {
  HOUR,
  MINUTE,
  protectionOf,
  safetyBlockers,
  cacheExpiry,
  classify,
  cacheLifeMs,
  decide,
  formatExpiresIn,
  issueFor,
  titleIdentifier,
  type Classification,
  type Decision,
  type EnvFacts,
  type LifecycleAction,
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

/** After a failed send, the steward is told again no sooner than this. */
const FLAG_RETRY_MS = HOUR;

/** A flagged thread is reported to the steward at most this often. */
export const FLAG_EVERY_MS = 24 * HOUR;

/** How long Keep protects a thread. */
export const KEEP_MS = 24 * HOUR;

export interface ThreadsSettings {
  /** observe: only log decisions. act: carry them out. */
  mode: "observe" | "act";
  /** The kinds of action that are on in act mode. */
  actions: ReadonlySet<LifecycleAction>;
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
  /** Post a comment on a Linear issue under an id that `key` derives, so a repeat with the same key posts nothing new, whatever its text. Errors come back without the key. */
  comment(issueId: string, body: string, key: string): Promise<void>;
  /** The issue as Linear has it now, or null when it has gone; undefined when Linear could not be read. */
  issue(identifier: string): Promise<IssueFacts | null | undefined>;
  /** The steward thread to tell, or null when none is set or bb reports it gone. */
  steward(): Promise<string | null>;
  /** Send a message to a thread, queued if it is running. */
  send(threadId: string, text: string): Promise<void>;
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
    id: issue.id,
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

/** A Linear issue as the lifecycle reads it. */
export const lifecycleFacts = (issue: LifecycleIssue): IssueFacts => asFacts(withComments(issue));

/** Whether a remote has a branch of this name. A failed or cut-off read says no. */
async function onRemote(sdk: Sdk, environmentId: string, branch: string): Promise<boolean> {
  try {
    const { remoteBranches } = await sdk.environments.diffBranches({ environmentId, query: branch, limit: "100" });
    return remoteBranches.some((name) => name === branch || name.endsWith(`/${branch}`));
  } catch {
    return false;
  }
}

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
    const branch = checkout.kind === "branch" ? checkout.branchName : (workspace.branch?.currentBranch ?? null);
    // bb gives commits ahead of the base branch, not ahead of the upstream. A branch on a remote is safe: its commits are kept
    // either way, because bb keeps the branch of a torn-down worktree while any commit is not on a remote.
    let ahead = merge !== null && ((merge.aheadCount ?? 0) > 0 || merge.hasCommittedUnmergedChanges === true);
    if (ahead && branch !== null && (await onRemote(sdk, environmentId, branch))) ahead = false;
    return {
      known: true,
      clean: tree === "clean" || tree === "committed_unmerged",
      ahead,
      branch,
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
  const lastDecision = db.prepare("SELECT decision, reason, result, error FROM thread_decisions WHERE thread_id = ? AND cycle = ? ORDER BY id DESC LIMIT 1");
  const insertDecision = db.prepare(
    "INSERT INTO thread_decisions (at, thread_id, thread_title, cycle, decision, state, reason, inputs, result, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const readDecisions = db.prepare("SELECT id, at, thread_id, thread_title, decision, state, reason, inputs, result, error FROM thread_decisions ORDER BY id DESC LIMIT ?");
  const compactedSince = db.prepare("SELECT 1 FROM thread_decisions WHERE thread_id = ? AND decision = 'compact' AND result = 'done' AND (cycle = ? OR at > ?) LIMIT 1");
  const lastFlag = db.prepare("SELECT sent_at FROM thread_flags WHERE thread_id = ?");
  const setFlag = db.prepare("INSERT INTO thread_flags (thread_id, sent_at) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET sent_at = excluded.sent_at");
  const clearFlag = db.prepare("DELETE FROM thread_flags WHERE thread_id = ?");
  const keepStmt = db.prepare("INSERT INTO thread_keeps (thread_id, until, at) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET until = excluded.until, at = excluded.at");
  const activeKeeps = db.prepare("SELECT thread_id, until FROM thread_keeps WHERE until > ?");

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

  /**
   * Record a decision once per cache life; again only when the decision, its
   * reason, or its result changes, so a pass that finds the same thing does not
   * repeat the row.
   */
  function record(entry: Pick<Entry, "row" | "facts" | "issue">, result: DecisionResult, extra: { error?: string; reason?: string; decision?: Decision } = {}): void {
    const { row, facts, issue } = entry;
    const decision = extra.decision ?? row.decision;
    const reason = extra.reason ?? row.reason;
    if (decision === "none") return;
    const error = extra.error ?? null;
    const last = lastDecision.get(row.id, row.expiresAt) as { decision: string; reason: string; result: string; error: string | null } | undefined;
    if (last !== undefined && last.decision === decision && last.reason === reason && last.result === result && last.error === error) return;
    insertDecision.run(now(), row.id, row.title, row.expiresAt, decision, row.state, reason, JSON.stringify(inputsOf(facts, issue, row.expiresAt, row.expiresSource)), result, error);
  }

  /** Record what the owner asked for from the page: always logged, never folded into an earlier row. */
  function recordAction(entry: Entry, decision: Decision, reason: string, result: DecisionResult, error: string | null = null): void {
    const { row, facts, issue } = entry;
    insertDecision.run(now(), row.id, row.title, row.expiresAt, decision, row.state, reason, JSON.stringify(inputsOf(facts, issue, row.expiresAt, row.expiresSource)), result, error);
  }

  interface Entry {
    row: ThreadRowView;
    facts: ThreadFacts;
    issue: IssueFacts | null | undefined;
    ctx: LifecycleContext;
    classification: Classification;
  }

  /** Read the checkout of a thread and of each thread below it, the state an archive of the thread depends on. */
  async function readArchiveEnvs(facts: ThreadFacts): Promise<void> {
    const reads = new Map<string, Promise<EnvFacts>>();
    const envOf = (environmentId: string | null | undefined): Promise<EnvFacts | null> => {
      if (environmentId === null || environmentId === undefined) return Promise.resolve(null);
      if (!reads.has(environmentId)) reads.set(environmentId, readEnv(sdk, environmentId));
      return reads.get(environmentId)!;
    };
    facts.env = await envOf(facts.environmentId);
    for (const child of facts.descendants ?? []) child.env = await envOf(child.environmentId);
  }

  /** Host names, by id; empty when bb cannot list them. */
  async function readHostNames(): Promise<Map<string, string>> {
    try {
      return new Map((await sdk.hosts.list()).map((host) => [host.id, host.name]));
    } catch {
      return new Map();
    }
  }

  /**
   * Every thread's facts, state, and verdict now. With `only`, just that
   * thread's, and without reading Linear: a manual action needs the thread as
   * it is, not its issue. A caller that has the issue passes it as `known`.
   */
  async function collect(only?: string, known?: { issue: IssueFacts | null | undefined }): Promise<{ at: number; linearError: string | null; entries: Entry[] }> {
    const settings = await deps.settings();
    const at = now();
    const listed = await listThreads();
    const childrenOf = new Map<string, string[]>();
    for (const row of listed) {
      if (row.parentThreadId !== null) childrenOf.set(row.parentThreadId, [...(childrenOf.get(row.parentThreadId) ?? []), row.id]);
    }
    const byId = new Map(listed.map((row) => [row.id, row]));
    const below = (id: string, seen: Set<string> = new Set()): string[] => {
      const out: string[] = [];
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child, ...below(child, seen));
      }
      return out;
    };
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

    const linear = only === undefined ? await readIssues() : { error: "not read" };
    const hostNames = await readHostNames();
    const kept = new Map((activeKeeps.all(at) as Array<{ thread_id: string; until: number }>).map((row) => [row.thread_id, row.until]));
    const issueCache = new Map<string, IssueWithComments | null>();
    const issueOf = async (thread: { id: string; title: string }): Promise<IssueFacts | null | undefined> => {
      if (only !== undefined) return known?.issue;
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

    const wanted = only === undefined ? listed : listed.filter((thread) => thread.id === only);
    const entries = await mapLimit(wanted, READ_CONCURRENCY, async (thread): Promise<Entry> => {
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
        // An archive takes these with it, so each one's protection and checkout count.
        descendants: below(thread.id).map((childId) => {
          const child = byId.get(childId)!;
          return {
            id: childId,
            protectedBy: protectionOf({ id: childId, pinned: child.pinnedAt !== null }, { now: at, stewardThread: settings.stewardThread, keptUntil: kept.get(childId) ?? null }),
            environmentId: child.environmentId,
            busy:
              child.queuedWork !== "none"
                ? "has a queued message"
                : child.activity.activeBackgroundAgentCount + child.activity.activeBackgroundCommandCount + child.activity.activeWorkflowCount > 0
                  ? "has background work running"
                  : null,
          };
        }),
      };
      const ctx: LifecycleContext = { now: at, issue, stewardThread: settings.stewardThread, keptUntil: kept.get(thread.id) ?? null };
      const classification = classify(facts, ctx);
      const expiry = cacheExpiry(facts, settings.cacheLifeOverrides);
      let verdict = decide(facts, classification, ctx, settings.cacheLifeOverrides);
      // An archive needs the checkout's state: read it only for a thread that could be archived now.
      if (classification.state === "done" || classification.state === "parked") {
        await readArchiveEnvs(facts);
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
        hostName: facts.hostId === null ? null : (hostNames.get(facts.hostId) ?? null),
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
      return { row, facts, issue, ctx, classification };
    });
    return { at, linearError: "error" in linear && only === undefined ? linear.error : null, entries };
  }

  /** The settings kind that turns on the archive or compact a verdict calls for. */
  function actionFor(entry: Entry): LifecycleAction | null {
    if (entry.row.decision === "compact") return "compact";
    if (entry.row.decision === "archive") return entry.row.state === "parked" ? "archive-parked" : "archive-done";
    return null;
  }

  /**
   * Act mode, at decision time: read the thread again, since it may have
   * changed since the pass began, check it is still safe, then archive or
   * compact. Returns whether the thread was archived. Every outcome is logged.
   */
  async function carryOut(entry: Entry, settings: ThreadsSettings): Promise<boolean> {
    const action = entry.row.decision === "compact" ? "compact" : "archive";
    // The issue may have changed too: a Done that reopened is no reason to archive.
    let issue = entry.issue;
    if (issue !== null && issue !== undefined) {
      issue = await deps.issue(issue.identifier);
      if (issue === undefined) {
        record(entry, "refused", { reason: "changed since the decision: the issue could not be read again" });
        return false;
      }
    }
    const fresh = (await collect(entry.row.id, { issue })).entries[0];
    if (fresh === undefined) {
      record(entry, "refused", { reason: "changed since the decision: the thread is gone" });
      return false;
    }
    if (fresh.row.decision !== entry.row.decision) {
      record(entry, "refused", { reason: `changed since the decision: now ${fresh.row.state}, ${fresh.row.decision} (${fresh.row.reason})` });
      return false;
    }
    if (action === "archive" && fresh.facts.env === undefined) await readArchiveEnvs(fresh.facts);
    const blockers = actionBlockers(fresh, action);
    if (blockers.length > 0) {
      record(entry, "refused", { reason: `changed since the decision: ${blockers.join("; ")}` });
      return false;
    }
    if (action === "compact") {
      const life = cacheLifeMs(fresh.facts.providerId, settings.cacheLifeOverrides).ms;
      // Once per cache cycle (the same expiry), and not within one cache life of the last: a compact starts a new life.
      if (compactedSince.get(fresh.row.id, fresh.row.expiresAt, now() - life) !== undefined) return false;
    }
    if (action === "archive" && fresh.issue !== null && fresh.issue !== undefined) {
      const env = fresh.facts.env;
      const body = `[agent:sgc-steward] archived ${fresh.row.id}: ${fresh.row.reason}; branch ${env?.branch ?? "none"} at ${env?.head ?? "none"}`;
      try {
        await deps.comment(fresh.issue.id, body, `archived:${fresh.row.id}:${fresh.facts.lastActivityAt}`);
      } catch (error) {
        record(entry, "failed", { error: `could not post the issue comment: ${message(error)}` });
        return false;
      }
    }
    try {
      if (action === "archive") await sdk.threads.archive({ threadId: fresh.row.id });
      else await sdk.threads.compact({ threadId: fresh.row.id });
    } catch (error) {
      record(entry, "failed", { error: message(error) });
      return false;
    }
    record(entry, "done");
    return action === "archive";
  }

  /** Act mode: tell the steward that a thread needs attention, once a day per thread. */
  async function flagSteward(entry: Entry): Promise<void> {
    const steward = await deps.steward();
    if (steward === null) {
      record(entry, "observed");
      return;
    }
    const id = entry.row.id;
    const previous = lastFlag.get(id) as { sent_at: number } | undefined;
    if (previous !== undefined && now() - previous.sent_at < FLAG_EVERY_MS) return;
    // Kept before the send, so a crash after it does not send twice; a send that failed is forgotten, so the next pass tries again.
    setFlag.run(id, now());
    try {
      await deps.send(steward, `[sgc-steward] Thread ${id} stuck: ${entry.row.reason}`);
    } catch (error) {
      // A reply that was lost may hide a message that landed, so the retry waits an hour rather than repeating at the next pass.
      setFlag.run(id, now() - FLAG_EVERY_MS + FLAG_RETRY_MS);
      record(entry, "failed", { error: `could not tell the steward: ${message(error)}` });
      return;
    }
    record(entry, "done");
  }

  /** `acting` is true only for the background service: the CLI and the page read and log, as observed. */
  async function gather(acting: boolean): Promise<ThreadsView> {
    const settings = await deps.settings();
    const { at, linearError, entries } = await collect();
    const archived = new Set<string>();
    for (const entry of entries) {
      const kind = actionFor(entry);
      if (settings.mode !== "act" || !acting) record(entry, "observed");
      else if (kind !== null && settings.actions.has(kind)) {
        if (await carryOut(entry, settings)) archived.add(entry.row.id);
      } else if (entry.row.decision === "flag") await flagSteward(entry);
      else record(entry, "observed");
    }
    const rows = entries
      .filter((entry) => !archived.has(entry.row.id))
      .map((entry) => entry.row)
      .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
    return { checkedAt: at, mode: settings.mode, linearError, threads: rows };
  }

  /** What stops an archive or a compact of this thread now: empty when it may go ahead. */
  function actionBlockers(entry: Entry, action: "compact" | "archive"): string[] {
    const { facts, ctx } = entry;
    const blockers: string[] = [];
    if (facts.status === "error") blockers.push("the thread is in error");
    else if (ACTIVE.has(facts.status)) blockers.push("a turn is running");
    if (facts.queuedCount > 0) blockers.push("it has a queued message");
    // A compact leaves the checkout and the children alone.
    blockers.push(...safetyBlockers(action === "archive" ? facts : { ...facts, env: null, descendants: [] }, ctx));
    return blockers;
  }

  /** Keep, Compact now, or Archive now, as the owner asked from the page; refused with the reason when the thread is not safe. */
  function act(threadId: string, action: RowAction): Promise<{ message: string }> {
    return locked(async () => {
      const { entries } = await collect(threadId);
      const entry = entries[0];
      if (entry === undefined) throw new Refusal("not_found", `No thread ${threadId}.`);
      if (action === "keep") {
        const at = now();
        keepStmt.run(threadId, at + KEEP_MS, at);
        recordAction(entry, "keep", "kept for 24 hours by the owner (Keep on the page)", "done");
        return { message: `${threadId} is protected for 24 hours.` };
      }
      if (action === "archive") await readArchiveEnvs(entry.facts);
      const blockers = actionBlockers(entry, action);
      if (blockers.length > 0) throw new Refusal("conflict", `Cannot ${action} ${threadId}: ${blockers.join("; ")}.`);
      const reason = `${action === "archive" ? "Archive" : "Compact"} now: asked from the page`;
      try {
        if (action === "archive") await sdk.threads.archive({ threadId });
        else await sdk.threads.compact({ threadId });
      } catch (error) {
        recordAction(entry, action, reason, "failed", message(error));
        throw new Error(`Could not ${action} ${threadId}: ${message(error)}`);
      }
      recordAction(entry, action, reason, "done");
      return { message: action === "archive" ? `Archived ${threadId}.` : `Compacting ${threadId}.` };
    });
  }

  /** Read every thread now, log the decisions, and keep the snapshot. In act mode only a pass with `acting` carries them out. */
  function refresh(acting = false): Promise<ThreadsView> {
    return locked(async () => {
      const view = await gather(acting);
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
      error: string | null;
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
      ...(row.error === null ? {} : { error: row.error }),
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    }));
  }

  return { refresh, cached, decisions, act };
}

export type ThreadsService = ReturnType<typeof createThreads>;

function tokens(count: number | null): string {
  return count === null ? "-" : tokenCount(count);
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
