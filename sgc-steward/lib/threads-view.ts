// The Threads tab's view model, for the page and the CLI: what each row says,
// how rows group and sort, the summary line, the badge count, and when a
// button must refuse. Browser-safe: it imports nothing that reaches a Node
// builtin (lib/page-imports.test.ts guards it).

import { MINUTE, formatExpiresIn, type Decision, type ThreadState } from "./lifecycle.ts";
import { appLink } from "./links.ts";

export type DecisionResult = "observed" | "done" | "failed";

/** One thread as the snapshot holds it. */
export interface ThreadRowView {
  id: string;
  title: string;
  state: ThreadState;
  stateReason: string;
  issue: { identifier: string; url: string; stateName: string } | null;
  provider: string;
  model: string | null;
  hostId: string | null;
  hostName: string | null;
  environmentId: string | null;
  usedTokens: number | null;
  contextWindow: number | null;
  lastActivityAt: number;
  expiresAt: number;
  expiresSource: "offer" | "provider-table" | "override";
  /** The countdown as of the snapshot; the page recomputes it from `expiresAt`. */
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
  /** Why a failed action failed. */
  error?: string;
  inputs: Record<string, unknown>;
}

export type RowAction = "keep" | "compact" | "archive";

/** The window in which a thread counts as going cold. */
export const GOING_COLD_MS = 15 * MINUTE;
const NO_HOST = "(no host)";
const STATE_ORDER: readonly ThreadState[] = ["working", "waiting", "idle-active", "parked", "done", "orphan", "stuck", "protected"];

/** `150k`, `1.5M`, or `950`. */
export function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/** `used / window`; `-` when the usage is unknown. */
export function tokensText(used: number | null, window: number | null): string {
  if (used === null) return "-";
  return `${tokenCount(used)} / ${window === null ? "?" : tokenCount(window)}`;
}

export type StateTone = "active" | "neutral" | "quiet" | "warning" | "critical";

const TONES: Record<ThreadState, StateTone> = {
  working: "active",
  waiting: "active",
  "idle-active": "neutral",
  parked: "quiet",
  done: "quiet",
  orphan: "warning",
  stuck: "critical",
  protected: "quiet",
};

/** The newest log entry of a thread as text: `archive done 5m ago`; `-` when it has none. */
export function lastAction(threadId: string, log: readonly DecisionRow[], now: number): string {
  let newest: DecisionRow | null = null;
  for (const entry of log) if (entry.threadId === threadId && (newest === null || entry.at > newest.at)) newest = entry;
  return newest === null ? "-" : `${newest.decision} ${newest.result} ${formatExpiresIn(now - newest.at)} ago`;
}

export interface RowText {
  title: string;
  state: ThreadState;
  stateTone: StateTone;
  issue: { identifier: string; href: string } | null;
  providerModel: string;
  tokens: string;
  expires: string;
  decision: Decision;
  reason: string;
  lastAction: string;
}

/** The text of one row, as of `now`, with the log's newest entry for the thread as its last action. */
export function rowText(thread: ThreadRowView, now: number, log: readonly DecisionRow[]): RowText {
  return {
    title: thread.title === "" ? thread.id : thread.title,
    state: thread.state,
    stateTone: TONES[thread.state],
    issue: thread.issue === null ? null : { identifier: thread.issue.identifier, href: appLink(thread.issue.url) },
    providerModel: `${thread.provider}/${thread.model ?? "?"}`,
    tokens: tokensText(thread.usedTokens, thread.contextWindow),
    expires: formatExpiresIn(thread.expiresAt - now),
    decision: thread.decision,
    reason: thread.reason,
    lastAction: lastAction(thread.id, log, now),
  };
}

export interface HostGroup {
  hostId: string | null;
  name: string;
  threads: ThreadRowView[];
}

/** Threads grouped by host, hosts in alphabetical order with threads on no host last, each group soonest cache expiry first. */
export function groupByHost(threads: readonly ThreadRowView[]): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  for (const thread of threads) {
    const key = thread.hostId ?? "";
    const group = groups.get(key) ?? { hostId: thread.hostId, name: thread.hostId === null ? NO_HOST : (thread.hostName ?? thread.hostId), threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.threads.sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => (a.hostId === null ? 1 : b.hostId === null ? -1 : a.name.localeCompare(b.name)));
}

export interface Summary {
  total: number;
  counts: Partial<Record<ThreadState, number>>;
  /** Threads whose cache expires within the next 15 minutes. */
  goingCold: number;
  /** Tokens in the contexts of threads whose cache has already expired. */
  coldTokens: number;
  mode: "observe" | "act";
}

/** A running thread is never cold or going cold: its cache is in use. */
export function summarize(view: ThreadsView, now: number): Summary {
  const counts: Partial<Record<ThreadState, number>> = {};
  let goingCold = 0;
  let coldTokens = 0;
  for (const thread of view.threads) {
    counts[thread.state] = (counts[thread.state] ?? 0) + 1;
    if (thread.state === "working") continue;
    const left = thread.expiresAt - now;
    if (left <= 0) coldTokens += thread.usedTokens ?? 0;
    else if (left <= GOING_COLD_MS) goingCold += 1;
  }
  return { total: view.threads.length, counts, goingCold, coldTokens, mode: view.mode };
}

export function summaryText(summary: Summary): string {
  const counted = STATE_ORDER.filter((state) => summary.counts[state] !== undefined).map((state) => `${summary.counts[state]} ${state}`);
  const head = `${summary.total} thread${summary.total === 1 ? "" : "s"}${counted.length === 0 ? "" : `: ${counted.join(", ")}`}.`;
  const cold = summary.coldTokens === 0 ? "0" : tokenCount(summary.coldTokens);
  return `${head} ${summary.goingCold} going cold in the next 15 minutes. ${cold} tokens held in cold threads. Mode: ${summary.mode}.`;
}

/** Threads that need the owner's eye: stuck, or flagged by a decision. */
export function attentionCount(view: ThreadsView): number {
  return view.threads.filter((thread) => thread.state === "stuck" || thread.decision === "flag").length;
}

/**
 * The reason a button must refuse a row, from what the row shows, or null.
 * The server checks again against the thread as it is now, and may refuse
 * for more: a dirty checkout, a child at work.
 */
export function buttonRefusal(thread: Pick<ThreadRowView, "state">, action: RowAction): string | null {
  if (action === "keep") return thread.state === "protected" ? "Already protected." : null;
  if (thread.state === "protected") return "Protected threads are never archived or compacted.";
  if (thread.state === "working") return "A turn is running. Wait until the thread is idle.";
  if (thread.state === "waiting") return "The thread has a queued message or a child at work. Wait until it is idle.";
  return null;
}
