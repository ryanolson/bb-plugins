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
  COMPACT_MIN_TOKENS,
  HOUR,
  MINUTE,
  ORPHAN_IDLE_MS,
  protectionOf,
  safetyBlockers,
  envlessBlockers,
  cacheExpiry,
  claimThread,
  classify,
  cacheLifeMs,
  closureAt,
  completionOf,
  decide,
  briefIdentifier,
  formatExpiresIn,
  issueFor,
  titleIdentifier,
  type Classification,
  type Decision,
  type EnvFacts,
  type LifecycleAction,
  type IssueFacts,
  type IssueLink,
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

const asFacts = (issue: IssueWithComments, threadId: string, link: IssueLink): IssueFacts => {
  const { comments, ...facts } = issue;
  return { ...facts, link, closureAt: closureAt(comments, threadId) };
};

/** A strong link: the thread claimed the issue in a comment, or its title names it. */
function linkOf(issue: IssueWithComments, threadId: string): IssueLink {
  return issue.comments.some((comment) => claimThread(comment.body) === threadId.toLowerCase()) ? "claim" : "title";
}


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
  /** The identifier a brief names, by team and thread; "" for a brief that names none. */
  const briefs = new Map<string, string>();

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

  /**
   * Every unarchived thread, and whether the list is whole. A list that stops
   * at the page cap may hide a child, so an archive waits for a smaller list.
   */
  async function listThreads(): Promise<{ rows: Awaited<ReturnType<Sdk["threads"]["list"]>>; complete: boolean }> {
    const rows: Awaited<ReturnType<Sdk["threads"]["list"]>> = [];
    const seen = new Set<string>();
    let complete = false;
    let stable = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await sdk.threads.list({ includeHidden: true, limit: THREADS_PAGE, offset: page * THREADS_PAGE });
      for (const row of batch) {
        // A row seen twice means a thread was inserted or removed between pages, so other rows were skipped.
        if (seen.has(row.id)) stable = false;
        seen.add(row.id);
      }
      rows.push(...batch);
      if (batch.length < THREADS_PAGE) {
        complete = true;
        break;
      }
    }
    if (!complete) deps.log(`bb returned ${rows.length} threads, its page cap, so some may be missing`);
    if (!stable) deps.log("bb's thread list changed while it was read, so some threads may be missing");
    return { rows: rows.filter((row) => row.archivedAt === null && row.deletedAt === null), complete: complete && stable };
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

  /**
   * The issue identifier a thread's brief names, or null. The brief is its first
   * user turn. It is read only once a thread has been idle long enough to count
   * as an orphan, where the link changes the verdict, and only the identifier is
   * kept, so a long session does not hold every brief in memory. A read that
   * finds nothing is not kept.
   */
  async function readBriefIssue(threadId: string, teamKey: string): Promise<string | null> {
    const key = `${teamKey}/${threadId}`;
    const known = briefs.get(key);
    if (known !== undefined) return known === "" ? null : known;
    try {
      const [first] = await sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "asc", limit: "1" });
      // A thread whose first turn has not arrived is asked again next pass. Once it exists, its text never changes.
      if (first === undefined || first.type !== "client/turn/requested") return null;
      const text = first.data.input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const identifier = briefIdentifier(text, teamKey);
      briefs.set(key, identifier ?? "");
      return identifier;
    } catch (error) {
      deps.log(`could not read the brief of ${threadId}: ${message(error)}`);
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
      issueLink: issue?.link ?? null,
      closedByComment: issue?.closureAt ?? null,
      children: (facts.descendants ?? []).map((child) => child.id),
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

  /** Read a thread's own checkout, the state its archive depends on. A live child stops the archive before this is needed. */
  async function readArchiveEnv(facts: ThreadFacts, reads: Map<string, Promise<EnvFacts>> = new Map()): Promise<void> {
    const environmentId = facts.environmentId;
    if (environmentId === null) {
      facts.env = null;
      return;
    }
    if (!reads.has(environmentId)) reads.set(environmentId, readEnv(sdk, environmentId));
    facts.env = await reads.get(environmentId)!;
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
   * it is, not its issue. `lookup` reads Linear for that thread's issue too, as the pass did; otherwise a caller that knows the issue passes it as `issue`.
   */
  async function collect(only?: string, options: { lookup?: boolean; issue?: IssueFacts | null | undefined } = {}): Promise<{ at: number; linearError: string | null; entries: Entry[] }> {
    const settings = await deps.settings();
    const at = now();
    const { rows: listed, complete } = await listThreads();
    const childrenOf = new Map<string, string[]>();
    // An archive follows the parent, the lifecycle owner and a spawned thread's source alike. Working state follows only the first two: a fork is not the source's child at work.
    const busyOf = new Map<string, string[]>();
    for (const row of listed) {
      for (const owner of new Set([row.parentThreadId, row.lifecycleOwnerThreadId, row.sourceThreadId])) {
        if (owner !== null) childrenOf.set(owner, [...(childrenOf.get(owner) ?? []), row.id]);
      }
      for (const owner of new Set([row.parentThreadId, row.lifecycleOwnerThreadId])) {
        if (owner !== null) busyOf.set(owner, [...(busyOf.get(owner) ?? []), row.id]);
      }
    }
    const byId = new Map(listed.map((row) => [row.id, row]));
    // The root is in `seen` from the start, so a fork edge back to it cannot make a thread its own descendant.
    const below = (id: string, seen: Set<string> = new Set([id])): string[] => {
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
      const result = (busyOf.get(id) ?? []).some((child) => ACTIVE.has(byId.get(child)?.status ?? "") || descendantWorking(child, seen));
      working.set(id, result);
      return result;
    };

    const linear = only === undefined || options.lookup ? await readIssues() : { error: "not read" };
    const hostNames = await readHostNames();
    const kept = new Map((activeKeeps.all(at) as Array<{ thread_id: string; until: number }>).map((row) => [row.thread_id, row.until]));
    const issueCache = new Map<string, IssueWithComments | null>();
    /** `brief` is true only for a thread old enough to be an orphan, where the brief's link changes its state. */
    const issueOf = async (thread: { id: string; title: string }, brief: boolean): Promise<IssueFacts | null | undefined> => {
      if (only !== undefined && !options.lookup) return options.issue;
      if ("error" in linear) return undefined;
      const strong = issueFor(thread, linear.issues, linear.teamKey);
      if (strong !== null) return asFacts(strong, thread.id, linkOf(strong, thread.id));
      // The title and the claims named nothing: the brief may name the issue, and a weak link may label the thread but never finish it.
      const identifier = brief ? await readBriefIssue(thread.id, linear.teamKey) : null;
      const weak = issueFor(thread, linear.issues, linear.teamKey, identifier);
      if (weak !== null) return asFacts(weak, thread.id, "brief");
      const named = titleIdentifier(thread.title, linear.teamKey);
      const wanted = named ?? identifier;
      if (wanted === null) return null;
      // An issue older than the lookback: ask for it by name.
      if (!issueCache.has(wanted)) {
        try {
          const one = await linear.client.getLifecycleIssue(wanted);
          issueCache.set(wanted, one === null ? null : withComments(one));
        } catch {
          return undefined;
        }
      }
      const older = issueCache.get(wanted);
      if (older === undefined || older === null) return null;
      return asFacts(older, thread.id, named === null ? "brief" : linkOf(older, thread.id));
    };

    const wanted = only === undefined ? listed : listed.filter((thread) => thread.id === only);
    const envReads = new Map<string, Promise<EnvFacts>>();
    const entries = await mapLimit(wanted, READ_CONCURRENCY, async (thread): Promise<Entry> => {
      const title = thread.title ?? "";
      const used = await readUsage(thread);
      // The brief decides an orphan, and turns a big idle thread's let-cool into a compact, so it is read for both.
      const wantBrief = at - thread.updatedAt >= ORPHAN_IDLE_MS || (used.used ?? 0) >= COMPACT_MIN_TOKENS;
      const [model, queue, issue] = await Promise.all([
        readModel(thread.id),
        readQueue(thread),
        issueOf({ id: thread.id, title }, wantBrief),
      ]);
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
        graphComplete: complete,
        // An archive takes these with it, so each one's protection and checkout count.
        descendants: below(thread.id).map((childId) => {
          const child = byId.get(childId)!;
          return {
            id: childId,
            title: child.title ?? child.titleFallback ?? childId,
            protectedBy: protectionOf({ id: childId, pinned: child.pinnedAt !== null }, { now: at, stewardThread: settings.stewardThread, keptUntil: kept.get(childId) ?? null }),
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
      // An archive needs the checkout's state, but only when nothing else already blocks it: a child that is still live is reason enough.
      if (classification.state === "done" || classification.state === "parked") {
        if (envlessBlockers(facts, ctx).length === 0) await readArchiveEnv(facts, envReads);
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
  async function carryOut(entry: Entry): Promise<boolean> {
    const action = entry.row.decision === "compact" ? "compact" : "archive";
    // An archive's issue is worked out again, from its title and the claims as they are now: it may have been retitled, claimed by another issue, or reopened. A compact does not depend on the issue, so it does not pay for that read.
    const how = action === "archive" ? ({ lookup: true } as const) : ({ issue: entry.issue } as const);
    const first = await recheck(entry, action, how);
    if ("refusal" in first) {
      record(first.fresh ?? entry, "refused", { reason: first.refusal, decision: entry.row.decision });
      return false;
    }
    const { fresh } = first;
    if (action === "compact") {
      const life = cacheLifeMs(fresh.facts.providerId, first.settings.cacheLifeOverrides).ms;
      // Once per cache cycle (the same expiry), and not within one cache life of the last: a compact starts a new life.
      if (compactedSince.get(fresh.row.id, fresh.row.expiresAt, now() - life) !== undefined) return false;
    }
    if (action === "archive" && fresh.issue !== null && fresh.issue !== undefined) {
      const env = fresh.facts.env;
      const body = `[agent:sgc-steward] archived ${fresh.row.id}: ${fresh.row.reason}; branch ${env?.branch ?? "none"} at ${env?.head ?? "none"}`;
      try {
        await deps.comment(fresh.issue.id, body, `archived:${fresh.row.id}:${fresh.issue.id}`);
      } catch (error) {
        record(entry, "failed", { error: `could not post the issue comment: ${message(error)}` });
        return false;
      }
    }
    // The comment takes time: the whole check runs once more, as late as possible, on the thread, its checkouts, its cache, the issue, and the settings as they are then. A Linear read that fails here refuses the archive.
    const late = await recheck(entry, action, action === "archive" ? { lookup: true } : { issue: fresh.issue });
    if ("refusal" in late) {
      record(late.fresh ?? entry, "refused", { reason: late.refusal, decision: entry.row.decision });
      return false;
    }
    if (action === "archive") {
      // bb's own count, asked right before it takes the children too: a child spawned after the recheck above must not be swept.
      const close = await unarchivedBelow(late.fresh.row.id);
      if (close > 0) {
        record(late.fresh, "refused", { reason: `changed since the decision: bb reports ${close} unarchived thread${close === 1 ? "" : "s"} below it`, decision: entry.row.decision });
        return false;
      }
      // The settings are read once more after that call, so a switch to observe during it still stops the archive.
      const settings = await deps.settings();
      const kind = actionFor(late.fresh);
      if (settings.mode !== "act" || kind === null || !settings.actions.has(kind)) {
        record(late.fresh, "refused", { reason: "changed since the decision: act mode or the action was turned off", decision: entry.row.decision });
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
    record(late.fresh, "done");
    return action === "archive";
  }

  /**
   * Read the thread again, with the settings as they are now, and check that
   * the action decided is still the one to take, still turned on, and still
   * safe. Returns the fresh entry, or why not.
   */
  async function recheck(
    entry: Entry,
    action: "compact" | "archive",
    how: { lookup: true } | { issue: IssueFacts | null | undefined },
  ): Promise<{ fresh: Entry; settings: ThreadsSettings } | { refusal: string; fresh?: Entry }> {
    const fresh = (await collect(entry.row.id, "lookup" in how ? { lookup: true } : { issue: how.issue })).entries[0];
    const changed = (why: string) => (fresh === undefined ? { refusal: `changed since the decision: ${why}` } : { refusal: `changed since the decision: ${why}`, fresh });
    if (fresh === undefined) return changed("the thread is gone");
    if (action === "archive" && fresh.facts.env === undefined) await readArchiveEnv(fresh.facts);
    // The settings are read last, after every await that reads bb, so a change during those reads counts.
    const settings = await deps.settings();
    if (settings.mode !== "act") return changed("act mode was turned off");
    if (entry.issue?.identifier !== fresh.issue?.identifier) return changed(`its issue is now ${fresh.issue?.identifier ?? "none"}, not ${entry.issue?.identifier ?? "none"}`);
    if (fresh.row.decision !== entry.row.decision) return changed(`now ${fresh.row.state}, ${fresh.row.decision} (${fresh.row.reason})`);
    const kind = actionFor(fresh);
    if (kind !== actionFor(entry) || kind === null || !settings.actions.has(kind)) {
      return changed(`its category is now ${fresh.row.state}, which is not the action that was decided or is turned off`);
    }
    const blockers = actionBlockers(fresh, action);
    if (blockers.length > 0) return changed(blockers.join("; "));
    if (action === "compact" && now() > fresh.row.expiresAt) return changed("the cache expired");
    return { fresh, settings };
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
      await deps.send(steward, `[sgc-steward] Thread ${id} ${entry.row.state}: ${entry.row.reason}`);
    } catch (error) {
      // A reply that was lost may hide a message that landed, and the steward is told once a day at most, so the time stays: the next try is tomorrow.
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
      try {
        if (settings.mode !== "act" || !acting) record(entry, "observed");
        else if (kind !== null && settings.actions.has(kind)) {
          if (await carryOut(entry)) archived.add(entry.row.id);
        } else if (entry.row.decision === "flag") await flagSteward(entry);
        else record(entry, "observed");
      } catch (error) {
        // One thread's failed read must not skip every thread after it: log it and go on.
        deps.log(`could not carry out ${entry.row.decision} for ${entry.row.id}: ${message(error)}`);
        record(entry, "failed", { error: message(error) });
      }
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
    // A compact leaves the checkout, the children, and the thread list alone.
    blockers.push(...safetyBlockers(action === "archive" ? facts : { ...facts, env: null, descendants: [], graphComplete: true }, ctx));
    return blockers;
  }

  /** Keep, Compact now, or Archive now, as the owner asked from the page; refused with the reason when the thread is not safe or not finished. */
  function act(threadId: string, action: RowAction): Promise<{ message: string }> {
    return locked(async () => {
      // An archive is held to the same completion rule as act mode, so it reads Linear; keep and compact do not need the issue.
      const { entries } = await collect(threadId, action === "archive" ? { lookup: true } : {});
      const entry = entries[0];
      if (entry === undefined) throw new Refusal("not_found", `No thread ${threadId}.`);
      if (action === "keep") {
        const at = now();
        keepStmt.run(threadId, at + KEEP_MS, at);
        recordAction(entry, "keep", "kept for 24 hours by the owner (Keep on the page)", "done");
        return { message: `${threadId} is protected for 24 hours.` };
      }
      if (action === "archive") await readArchiveEnv(entry.facts);
      const blockers = actionBlockers(entry, action);
      if (blockers.length > 0) throw new Refusal("conflict", `Cannot ${action} ${threadId}: ${blockers.join("; ")}.`);
      if (action === "archive") {
        const completion = completionOf(entry.issue);
        if (!completion.done) throw new Refusal("conflict", `Cannot archive ${threadId}: not finished: ${completion.why}.`);
        let close: number;
        try {
          close = await unarchivedBelow(threadId);
        } catch (error) {
          throw new Refusal("conflict", `Cannot archive ${threadId}: could not ask bb for the threads below it: ${message(error)}.`);
        }
        if (close > 0) throw new Refusal("conflict", `Cannot archive ${threadId}: bb reports ${close} unarchived thread${close === 1 ? "" : "s"} below it.`);
      }
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

  /**
   * How many unarchived threads bb would take with this one, asked of bb
   * itself just before an archive. A list could miss a child spawned between
   * its pages; this count cannot.
   */
  async function unarchivedBelow(threadId: string): Promise<number> {
    const { unarchivedDescendantCount } = await sdk.threads.childSummary({ threadId });
    return unarchivedDescendantCount;
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
