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
/** `keep` is only ever the owner's: the plugin itself decides the others. */
export type Decision = "archive" | "compact" | "let-cool" | "flag" | "keep" | "none";

/** The Linear issue a thread works on, as far as the lifecycle needs it. */
export interface IssueFacts {
  /** Linear's own id, for writes. */
  id: string;
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
  /** How the issue was found for this thread. A `brief` link can label a thread but never finish it. */
  link: IssueLink;
  /** Epoch ms of a signed closure comment naming this thread, or null. */
  closureAt: number | null;
}

/** A thread's issue, by how strongly the thread names it. */
export type IssueLink = "claim" | "title" | "brief";

/** What `environments.status` says about the thread's checkout. */
export interface EnvFacts {
  /** False when bb could not read the status: archiving is then unsafe. */
  known: boolean;
  /** No uncommitted or untracked changes. */
  clean: boolean;
  /**
   * Commits that neither the base branch nor a remote has: work that may exist
   * nowhere else. A branch that is on a remote does not count, even when it
   * has commits the base lacks: when bb tears down an archived worktree it
   * keeps the branch while any commit is not on a remote, so a later local
   * commit on a pushed branch stays in the repo, and the archive comment
   * names the branch and commit.
   */
  ahead: boolean;
  branch: string | null;
  head: string | null;
  detail: string | null;
}

/** A thread below another, which an archive of the parent archives with it. */
export interface DescendantFacts {
  id: string;
  /** For the reason text. */
  title?: string;
  /** Why it is protected, or null. */
  protectedBy: string | null;
  /** What keeps it from being archived with its parent: queued work or work in the background; null when idle. */
  busy?: string | null;
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
  /** False when `threads.list` stopped at its page cap, so a child may be unseen. Absent means complete. */
  graphComplete?: boolean;
  /** Every unarchived thread below this one: archiving the parent archives them too. */
  descendants?: DescendantFacts[];
  environmentId: string | null;
  hostId: string | null;
  /** Null for a thread with no environment; absent when it was not read. */
  env?: EnvFacts | null;
  /** Epoch ms bb created the thread; absent when not read. */
  createdAt?: number | null;
  /** The thread that owns its lifecycle, when bb names one; the Archive tab's parent when there is no parent. */
  ownerThreadId?: string | null;
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

/** Why a thread is protected, or null. */
export function protectionOf(thread: { id: string; pinned: boolean }, ctx: Pick<LifecycleContext, "now" | "stewardThread" | "keptUntil">): string | null {
  if (thread.id === MISSION_CONTROL_THREAD) return "Mission Control";
  if (ctx.stewardThread !== undefined && thread.id === ctx.stewardThread) return "the steward thread";
  if (thread.pinned) return "pinned in bb";
  if (ctx.keptUntil !== undefined && ctx.keptUntil !== null && ctx.keptUntil > ctx.now) return "kept by the owner";
  return null;
}

const isProtected = (facts: ThreadFacts, ctx: LifecycleContext) => protectionOf(facts, ctx);

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
  const completion = completionOf(issue);
  if (issue.stateType === "completed" || issue.stateType === "canceled") {
    return completion.done
      ? { state: "done", reason: completion.why }
      : { state: "idle-active", reason: `${issue.identifier} is ${issue.stateName}, but ${completion.why}` };
  }
  // The owner's or a reviewer's park wins over a closure comment: the archive it allows is `archive-parked`.
  if (issue.stateType === "backlog" && hasLabel(issue, (name) => name === "paused")) {
    return { state: "parked", reason: `${issue.identifier} is paused in the backlog` };
  }
  if (hasLabel(issue, (name) => name.startsWith("waiting:"))) return { state: "parked", reason: `${issue.identifier} is waiting on someone` };
  if (completion.done) return { state: "done", reason: completion.why };
  // A long, quiet review is only a guess at a park, so a closure comment beats it: the archive stays `archive-done`.
  if (/review/i.test(issue.stateName) && ctx.now - Math.max(issue.updatedAt, facts.lastActivityAt) >= REVIEW_PARKED_MS) {
    return { state: "parked", reason: `${issue.identifier} has been in review for 48 hours with nothing to do` };
  }
  return { state: "idle-active", reason: `${issue.identifier} is ${issue.stateName}` };
}

function envBlockers(env: EnvFacts | null | undefined, who: string): string[] {
  if (env === undefined) return [`${who} environment was not checked`];
  if (env === null) return [];
  if (!env.known) return [`${who} environment could not be read${env.detail === null ? "" : `: ${env.detail}`}`];
  return [...(env.clean ? [] : [`${who} environment has uncommitted changes`]), ...(env.ahead ? [`${who} branch has commits not on its base`] : [])];
}

/**
 * The blockers that need no environment read: protection, a working child,
 * and every live child. `collect` checks these before it reads any checkout.
 */
export function envlessBlockers(facts: ThreadFacts, ctx: LifecycleContext): string[] {
  const blockers: string[] = [];
  const guarded = isProtected(facts, ctx);
  if (guarded !== null) blockers.push(`the thread is protected: ${guarded}`);
  if (facts.childWorking) blockers.push("a child thread is working");
  if (facts.graphComplete === false) blockers.push("bb's thread list was cut off, so a child may be unseen");
  for (const child of facts.descendants ?? []) {
    blockers.push(`child ${child.id} is still live${child.title === undefined || child.title === "" ? "" : ` (${child.title.length > 60 ? `${child.title.slice(0, 59)}…` : child.title})`}`);
    if (child.protectedBy !== null) blockers.push(`child ${child.id} is protected: ${child.protectedBy}`);
    if (child.busy) blockers.push(`child ${child.id} ${child.busy}`);
  }
  return blockers;
}

/**
 * What stops an archive: empty when it is safe. A live child always stops it,
 * because an archive takes the thread's descendants with it and a child may be
 * doing work of its own. Its checkout is not read: the archive cannot happen.
 */
export function safetyBlockers(facts: ThreadFacts, ctx: LifecycleContext): string[] {
  return [...envlessBlockers(facts, ctx), ...envBlockers(facts.env, "the")];
}

/**
 * What to do with a thread. A compact is decided in the last minutes before
 * the cache expires. An archive of a done or parked thread, and a flag of a
 * stuck or orphan one, are decided whenever the thread is seen: neither has a
 * cache left to save, and a thread can stay stuck long after it is cold.
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

  // A finished or parked thread is archived whenever it is seen and safe: once its cache is cold there is nothing left to save. Completion comes first: an idle thread is not a finished one.
  if (state === "done" || state === "parked") {
    const completion = completionOf(ctx.issue);
    if (!completion.done) return { decision: "flag", reason: `${classification.state} but not finished: ${completion.why}`, inWindow };
    const blockers = safetyBlockers(facts, ctx);
    if (blockers.length > 0) return { decision: "flag", reason: `${classification.state} but not safe to archive: ${blockers.join("; ")}`, inWindow };
    return { decision: "archive", reason: classification.reason, inWindow };
  }

  // Only a compact depends on the cache: it is worth doing just before the cache expires.
  if (left < 0) return { decision: "none", reason: "the cache is already cold", inWindow };
  if (!inWindow) return { decision: "none", reason: `decides in the last ${window / MINUTE} minutes of the cache`, inWindow };

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

export interface IssueWithComments extends Omit<IssueFacts, "link" | "closureAt"> {
  comments: Array<{ body: string; createdAt: number }>;
}

/** A signed comment that opens as an indented or fenced code block is an example, not a signature. */
function isExample(body: string): boolean {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  // A tab advances to the next 4-column stop, so " \t" is as indented as four spaces.
  return /^\s*(```|~~~)/.test(first) || /^ {4,}/.test(first.replace(/\t/g, "    "));
}

/** The thread id a signed `claim:` comment names, or null. */
export function claimThread(body: string): string | null {
  if (isExample(body)) return null;
  const match = /^\[agent:[^\s\]]+[ \t]+(thr_[a-z0-9]+)[ \t]*\]\s*claim:/i.exec(body.trim());
  return match === null ? null : match[1]!.toLowerCase();
}

/**
 * The thread id a signed comment closes, or null. Only a `done:`, `closed:` or
 * `superseded:` comment counts, and never the plugin's own `archived` record:
 * that comment must not become the evidence for the archive it announces.
 */
export function closureThread(body: string): string | null {
  if (isExample(body)) return null;
  const match = /^\[agent:(?!sgc-steward\b)[^\s\]]+[ \t]+(thr_[a-z0-9]+)[ \t]*\]\s*(?:done|closed|superseded):/i.exec(body.trim());
  return match === null ? null : match[1]!.toLowerCase();
}

/** Epoch ms of the latest signed closure comment naming this thread, or null. */
export function closureAt(comments: ReadonlyArray<{ body: string; createdAt: number }>, threadId: string): number | null {
  let latest: number | null = null;
  for (const comment of comments) {
    if (closureThread(comment.body) === threadId.toLowerCase() && (latest === null || comment.createdAt > latest)) latest = comment.createdAt;
  }
  return latest;
}

/**
 * Whether an archive may treat the thread as finished. The issue must be Done
 * or Canceled, or carry a signed closure comment that names the thread. A
 * thread linked only by its brief is never finished: the brief may name a
 * related issue first. No issue, or an unreadable Linear, is not finished.
 */
export function completionOf(issue: IssueFacts | null | undefined): { done: boolean; why: string } {
  if (issue === null || issue === undefined) return { done: false, why: "no issue could be read for the thread" };
  if (issue.link === "brief") return { done: false, why: `only the thread's brief names ${issue.identifier}` };
  if (issue.stateType === "completed" || issue.stateType === "canceled") return { done: true, why: `${issue.identifier} is ${issue.stateName}` };
  if (!OPEN_STATE_TYPES.has(issue.stateType)) return { done: false, why: `${issue.identifier} has no readable state` };
  if (issue.closureAt !== null) return { done: true, why: `${issue.identifier} is ${issue.stateName}, with a signed closure comment` };
  return { done: false, why: `${issue.identifier} is ${issue.stateName}, with no closure comment` };
}

/** The states a thread can be open in. A comment closes one of these; an unknown state is no evidence. */
const OPEN_STATE_TYPES = new Set(["backlog", "unstarted", "started", "triage"]);

/** The first `TEAM-NNNN` anywhere in a thread's brief, or null. The weakest way a thread names its issue. */
export function briefIdentifier(brief: string, teamKey: string): string | null {
  const key = teamKey.replace(/[^A-Za-z0-9]/g, "");
  if (key === "") return null;
  const match = new RegExp(`\\b${key}-(\\d{1,6})\\b`, "i").exec(brief);
  return match === null ? null : `${teamKey.toUpperCase()}-${match[1]}`;
}

/** A thread's issue: the latest signed claim that names it, else its title's prefix, else the first issue its brief names. */
export function issueFor(thread: { id: string; title: string }, issues: readonly IssueWithComments[], teamKey: string, brief?: string | null): IssueWithComments | null {
  let best: { issue: IssueWithComments; at: number } | null = null;
  for (const issue of issues) {
    for (const comment of issue.comments) {
      if (claimThread(comment.body) === thread.id && (best === null || comment.createdAt > best.at)) best = { issue, at: comment.createdAt };
    }
  }
  if (best !== null) return best.issue;
  const identifier = titleIdentifier(thread.title, teamKey);
  if (identifier !== null) return issues.find((issue) => issue.identifier.toUpperCase() === identifier) ?? null;
  const fromBrief = briefIdentifier(brief ?? "", teamKey);
  return fromBrief === null ? null : (issues.find((issue) => issue.identifier.toUpperCase() === fromBrief) ?? null);
}

/** The kinds of action the plugin may take in act mode. */
export const LIFECYCLE_ACTIONS = ["archive-done", "archive-parked", "compact"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** The actions a `lifecycleActions` setting turns on: a comma-separated list; unknown names are ignored. */
export function parseLifecycleActions(text: string | undefined): Set<LifecycleAction> {
  const named = (text ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  return new Set(LIFECYCLE_ACTIONS.filter((action) => named.includes(action)));
}

/** Why a `lifecycleActions` value is wrong, or null. */
export function lifecycleActionsProblem(text: string): string | null {
  const unknown = text.split(",").map((name) => name.trim()).filter((name) => name !== "" && !(LIFECYCLE_ACTIONS as readonly string[]).includes(name));
  return unknown.length === 0 ? null : `Unknown action ${unknown.join(", ")}. Use ${LIFECYCLE_ACTIONS.join(", ")}.`;
}

const OVERRIDE = /^([A-Za-z0-9._-]+)\s*=\s*(\d+)$/;

/** Cache lives in milliseconds from `provider=minutes` pairs, comma-separated: `pi=360, claude-code=60`. Bad pairs are ignored. */
export function parseCacheLifeOverrides(text: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const pair of (text ?? "").split(",")) {
    const match = OVERRIDE.exec(pair.trim());
    if (match !== null && Number(match[2]) > 0) result[match[1]!] = Number(match[2]) * MINUTE;
  }
  return result;
}

/** Why a `cacheLifeOverrides` value is wrong, or null. */
export function cacheLifeOverridesProblem(text: string): string | null {
  for (const pair of text.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const match = OVERRIDE.exec(trimmed);
    if (match === null || Number(match[2]) <= 0) return `"${trimmed}" is not provider=minutes, like pi=360.`;
  }
  return null;
}
