// Thread lifecycle: what state each bb thread is in, when its provider's
// prompt cache runs out, and what to do with it before that happens.
//
// Pure: no bb SDK, no clock, no `node:` import. The caller gathers the facts
// and passes the time, so every rule here can be tested with plain objects and
// the page can use it later.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Mission Control's thread. It is never archived or compacted. */
export const MISSION_CONTROL_THREAD = "thr_zrybxd2ijw";

/**
 * How long each provider keeps a prompt cache after a thread's last turn, used
 * when bb gives no `compactionOfferAt`. The one table; settings may override
 * single rows. Pi and acp-opencode run our own Dynamo-served models.
 */
export const DEFAULT_CACHE_LIFE_MS: Readonly<Record<string, number>> = {
  "claude-code": HOUR,
  codex: HOUR,
  pi: 6 * HOUR,
  "acp-opencode": 6 * HOUR,
};
/** A provider that is not in the table is assumed to keep its cache for an hour. */
export const UNKNOWN_CACHE_LIFE_MS = HOUR;

/** bb offers its own Compact chip from this many tokens. */
export const COMPACT_MIN_TOKENS = 100_000;
/** The decision is made in the last 15 minutes before the cache expires. */
export const DECISION_WINDOW_MS = 15 * MINUTE;
/** A cache that lives less than this long gets the shorter window. */
export const SHORT_CACHE_LIFE_MS = 15 * MINUTE;
export const SHORT_DECISION_WINDOW_MS = 5 * MINUTE;
/** An idle thread with no issue is an orphan after this long. */
export const ORPHAN_IDLE_MS = 24 * HOUR;
/** An issue in review with no change for this long is parked. */
export const REVIEW_PARKED_MS = 48 * HOUR;
/** A queued turn older than this means the thread is stuck. */
export const STUCK_QUEUE_MS = 30 * MINUTE;

export type ThreadState = "working" | "waiting" | "idle-active" | "parked" | "done" | "orphan" | "stuck" | "protected";
export type Decision = "archive" | "compact" | "let-cool" | "flag" | "none";

/** The Linear issue a thread works on, as far as the lifecycle needs it. */
export interface IssueFacts {
  identifier: string;
  url: string;
  title: string;
  /** The workflow state's name, like "In Review". */
  stateName: string;
  /** backlog, unstarted, started, completed, canceled, triage. */
  stateType: string;
  /** Label names, with their groups as `group/name`. */
  labels: string[];
  /** Epoch ms of the issue's last change. */
  updatedAt: number;
}

/** What `environments.status` says about the thread's checkout. */
export interface EnvFacts {
  /** False when bb could not read the status: archiving is then unsafe. */
  known: boolean;
  /** No uncommitted or untracked changes. */
  clean: boolean;
  /** Commits that the base branch lacks: work that may exist nowhere else. */
  ahead: boolean;
  branch: string | null;
  head: string | null;
  detail: string | null;
}

export interface ThreadFacts {
  id: string;
  title: string;
  /** bb's thread status: idle, active, starting, stopping, pending, error. */
  status: string;
  parentThreadId: string | null;
  providerId: string;
  model: string | null;
  /** Epoch ms of the thread's last change. */
  lastActivityAt: number;
  /** Pinned in bb's sidebar. */
  pinned: boolean;
  usedTokens: number | null;
  contextWindow: number | null;
  /** Epoch ms when bb judges the prompt cache expired, if it says. */
  compactionOfferAt: number | null;
  cost: { amount: number; currency: string } | null;
  queuedCount: number;
  /** Epoch ms of the oldest queued turn. */
  oldestQueuedAt: number | null;
  /** Some descendant thread is running a turn. */
  childWorking: boolean;
  environmentId: string | null;
  hostId: string | null;
  /** Null for a thread with no environment; absent when it was not read. */
  env?: EnvFacts | null;
}

export interface LifecycleContext {
  now: number;
  /** The issue; null for none; undefined when Linear could not be read. */
  issue: IssueFacts | null | undefined;
  stewardThread: string | undefined;
  /** Epoch ms until which the owner pinned the thread as protected. */
  keptUntil?: number | null;
}

export interface Classification {
  state: ThreadState;
  reason: string;
}

export interface Expiry {
  at: number;
  source: "offer" | "provider-table" | "override";
}

export interface Verdict {
  decision: Decision;
  reason: string;
  /** Whether now is inside the decision window. */
  inWindow: boolean;
}

export function cacheLifeMs(providerId: string, overrides: Readonly<Record<string, number>> = {}): { ms: number; overridden: boolean } {
  const override = overrides[providerId];
  if (override !== undefined && override > 0) return { ms: override, overridden: true };
  return { ms: DEFAULT_CACHE_LIFE_MS[providerId] ?? UNKNOWN_CACHE_LIFE_MS, overridden: false };
}

/** When the thread's prompt cache expires: bb's offer time, else last activity plus the provider's cache life. */
export function cacheExpiry(facts: ThreadFacts, overrides: Readonly<Record<string, number>> = {}): Expiry {
  if (facts.compactionOfferAt !== null) return { at: facts.compactionOfferAt, source: "offer" };
  const life = cacheLifeMs(facts.providerId, overrides);
  return { at: facts.lastActivityAt + life.ms, source: life.overridden ? "override" : "provider-table" };
}

/** The decision window's length for a cache of this life. */
export function windowMs(lifeMs: number): number {
  return lifeMs < SHORT_CACHE_LIFE_MS ? SHORT_DECISION_WINDOW_MS : DECISION_WINDOW_MS;
}

const ACTIVE_STATUSES = new Set(["active", "starting", "stopping", "pending", "provisioning"]);

function isProtected(facts: ThreadFacts, ctx: LifecycleContext): string | null {
  if (facts.id === MISSION_CONTROL_THREAD) return "Mission Control";
  if (ctx.stewardThread !== undefined && facts.id === ctx.stewardThread) return "the steward thread";
  if (facts.pinned) return "pinned in bb";
  if (ctx.keptUntil !== undefined && ctx.keptUntil !== null && ctx.keptUntil > ctx.now) return "kept by the owner";
  return null;
}

function hasLabel(issue: IssueFacts, test: (name: string) => boolean): boolean {
  return issue.labels.some((label) => test(label.split("/").pop() ?? label));
}

/** The state of a thread. Protected threads are never anything else. */
export function classify(facts: ThreadFacts, ctx: LifecycleContext): Classification {
  const guarded = isProtected(facts, ctx);
  if (guarded !== null) return { state: "protected", reason: `protected: ${guarded}` };
  if (facts.status === "error") return { state: "stuck", reason: "the thread is in error" };
  if (ACTIVE_STATUSES.has(facts.status)) return { state: "working", reason: "a turn is running" };
  if (facts.oldestQueuedAt !== null && ctx.now - facts.oldestQueuedAt > STUCK_QUEUE_MS) {
    return { state: "stuck", reason: `a queued turn has waited ${Math.floor((ctx.now - facts.oldestQueuedAt) / MINUTE)} minutes` };
  }
  if (facts.queuedCount > 0) return { state: "waiting", reason: "idle with a queued message" };
  if (facts.childWorking) return { state: "waiting", reason: "idle while a child thread runs" };
  const idleMs = ctx.now - facts.lastActivityAt;
  const issue = ctx.issue;
  if (issue === undefined) return { state: "idle-active", reason: "the issue could not be read" };
  if (issue === null) {
    return idleMs >= ORPHAN_IDLE_MS
      ? { state: "orphan", reason: `no issue, idle ${Math.floor(idleMs / HOUR)} h` }
      : { state: "idle-active", reason: "no issue yet" };
  }
  if (issue.stateType === "completed" || issue.stateType === "canceled") return { state: "done", reason: `${issue.identifier} is ${issue.stateName}` };
  if (issue.stateType === "backlog" && hasLabel(issue, (name) => name === "paused")) {
    return { state: "parked", reason: `${issue.identifier} is paused in the backlog` };
  }
  if (hasLabel(issue, (name) => name.startsWith("waiting:"))) return { state: "parked", reason: `${issue.identifier} is waiting on someone` };
  if (/review/i.test(issue.stateName) && ctx.now - Math.max(issue.updatedAt, facts.lastActivityAt) >= REVIEW_PARKED_MS) {
    return { state: "parked", reason: `${issue.identifier} has been in review for 48 hours with nothing to do` };
  }
  return { state: "idle-active", reason: `${issue.identifier} is ${issue.stateName}` };
}

/** What stops an archive: empty when it is safe. */
export function safetyBlockers(facts: ThreadFacts, ctx: LifecycleContext): string[] {
  const blockers: string[] = [];
  const guarded = isProtected(facts, ctx);
  if (guarded !== null) blockers.push(`the thread is protected: ${guarded}`);
  if (facts.childWorking) blockers.push("a child thread is working");
  const env = facts.env;
  if (env === undefined) blockers.push("the environment was not checked");
  else if (env !== null) {
    if (!env.known) blockers.push(`the environment could not be read${env.detail === null ? "" : `: ${env.detail}`}`);
    else {
      if (!env.clean) blockers.push("the environment has uncommitted changes");
      if (env.ahead) blockers.push("the branch has commits not on its base");
    }
  }
  return blockers;
}

/**
 * What to do with a thread. Archive and compact are made in the last minutes
 * before the cache expires; a flag is made whenever the thread is stuck or an
 * orphan, since a thread can stay stuck long after its cache is cold.
 */
export function decide(facts: ThreadFacts, classification: Classification, ctx: LifecycleContext, overrides: Readonly<Record<string, number>> = {}): Verdict {
  const { state } = classification;
  const expiry = cacheExpiry(facts, overrides);
  const left = expiry.at - ctx.now;
  const life = facts.compactionOfferAt === null ? cacheLifeMs(facts.providerId, overrides).ms : Math.max(expiry.at - facts.lastActivityAt, 0);
  const window = windowMs(life);
  const inWindow = left <= window && left >= 0;

  if (state === "protected") return { decision: "none", reason: classification.reason, inWindow };
  if (state === "stuck" || state === "orphan") return { decision: "flag", reason: classification.reason, inWindow };
  if (state === "working" || state === "waiting") return { decision: "none", reason: classification.reason, inWindow };
  if (left < 0) return { decision: "none", reason: "the cache is already cold", inWindow };
  if (!inWindow) return { decision: "none", reason: `decides in the last ${window / MINUTE} minutes of the cache`, inWindow };

  if (state === "done" || state === "parked") {
    const blockers = safetyBlockers(facts, ctx);
    if (blockers.length > 0) return { decision: "flag", reason: `${classification.state} but not safe to archive: ${blockers.join("; ")}`, inWindow };
    return { decision: "archive", reason: classification.reason, inWindow };
  }
  // idle-active
  const tokens = facts.usedTokens ?? 0;
  if (tokens < COMPACT_MIN_TOKENS) return { decision: "let-cool", reason: `${tokens} tokens, under ${COMPACT_MIN_TOKENS}`, inWindow };
  if (ctx.issue === null || ctx.issue === undefined) return { decision: "let-cool", reason: "no open issue, so unlikely to resume", inWindow };
  return { decision: "compact", reason: `${tokens} tokens and ${ctx.issue.identifier} is open`, inWindow };
}

/** `42m`, `1h 5m`, or `cold` once past. */
export function formatExpiresIn(ms: number): string {
  if (ms <= 0) return "cold";
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Linear identifiers a title names: `TEAM-123` or `123:` at the start. */
export function titleIdentifier(title: string, teamKey: string): string | null {
  const text = title.trim();
  const named = new RegExp(`^${teamKey.replace(/[^A-Za-z0-9]/g, "")}-(\\d+)\\b`, "i").exec(text);
  if (named !== null) return `${teamKey.toUpperCase()}-${named[1]}`;
  const bare = /^(\d{1,6}):/.exec(text);
  return bare === null ? null : `${teamKey.toUpperCase()}-${bare[1]}`;
}

export interface IssueWithComments extends IssueFacts {
  comments: Array<{ body: string; createdAt: number }>;
}

/** The thread id a signed `claim:` comment names, or null. */
export function claimThread(body: string): string | null {
  const match = /^\[agent:[^\s\]]+[ \t]+(thr_[a-z0-9]+)[ \t]*\]\s*claim:/i.exec(body.trim());
  return match === null ? null : match[1]!.toLowerCase();
}

/** A thread's issue: the latest signed claim that names it, else its title's prefix. */
export function issueFor(thread: { id: string; title: string }, issues: readonly IssueWithComments[], teamKey: string): IssueWithComments | null {
  let best: { issue: IssueWithComments; at: number } | null = null;
  for (const issue of issues) {
    for (const comment of issue.comments) {
      if (claimThread(comment.body) === thread.id && (best === null || comment.createdAt > best.at)) best = { issue, at: comment.createdAt };
    }
  }
  if (best !== null) return best.issue;
  const identifier = titleIdentifier(thread.title, teamKey);
  return identifier === null ? null : (issues.find((issue) => issue.identifier.toUpperCase() === identifier) ?? null);
}
