// The Archive tab's view model: one row per archived thread, as the plugin
// recorded it when the thread was archived, and the roll-up of what a
// driver's child threads did. Everything here is composed from those recorded
// rows and the last lifecycle snapshot; nothing reads bb or Linear.
// Browser-safe: it imports nothing that reaches a Node builtin
// (lib/page-imports.test.ts guards it).

import { tokenCount } from "./threads-view.ts";

/**
 * Who archived the thread: the lifecycle's own pass, Archive now on the page,
 * or someone else (another thread, the owner in bb, or bb cascading a
 * parent's archive), which the plugin learns from bb's `thread.archived` event.
 */
export type ArchiveSource = "lifecycle" | "page" | "outside";

/** A child's role, from its title. A title that names none is `other`, never guessed. */
export type Phase = "plan" | "impl" | "review" | "other";
export const PHASES: readonly Phase[] = ["plan", "impl", "review", "other"];

/** One archived thread, as recorded at the moment it was archived. */
export interface ArchiveRecord {
  threadId: string;
  title: string;
  /** The thread it was spawned under, if any: its parent, else its lifecycle owner. */
  parentThreadId: string | null;
  provider: string | null;
  model: string | null;
  /** Epoch ms bb created the thread. */
  startedAt: number | null;
  /** Epoch ms of the latest archive. */
  archivedAt: number;
  source: ArchiveSource;
  /** The lifecycle state it was archived in (done, parked), or the state last seen for an outside archive; null when never seen. */
  state: string | null;
  /** The lifecycle's reason, in its words, or what the last snapshot said for an outside archive. */
  reason: string;
  issue: { identifier: string; url: string | null; stateName: string | null } | null;
  /** The thread's context size when archived; null when bb had no usage for it. */
  usedTokens: number | null;
  /** How many times the thread has been archived: an unarchive then a re-archive updates the same row. */
  archiveCount: number;
}

/** A thread below a driver, as its roll-up names it. */
export interface ArchiveChildView {
  threadId: string;
  title: string;
  /** Who did it: the model, else the provider, else the thread id. */
  name: string;
  phase: Phase;
  fate: string;
  usedTokens: number | null;
}

/** Where a row's parent is: archived (with its own row), still open in bb, or neither. */
export type ParentView =
  | { threadId: string; status: "archived"; title: string }
  | { threadId: string; status: "open"; title: string }
  | { threadId: string; status: "missing" };

export interface ArchiveRowView {
  record: ArchiveRecord;
  /** Why it was archived, in words. */
  why: string;
  parent: ParentView | null;
  /** Every recorded, still-archived thread below this one, oldest first. Empty for a thread that drove none. */
  children: ArchiveChildView[];
  /** A driver's roll-up of its children, or the thread's own fate when it drove none. */
  summary: string;
  /** The row's own tokens: `150k`, or `-` with no recorded usage. */
  tokens: string;
  /** A driver's children's tokens by phase, `plan 41k, impl 210k, review 66k`; null for a thread that drove none. */
  phaseTokens: string | null;
}

export interface ArchiveView {
  rows: ArchiveRowView[];
  /** Archived threads recorded in all, of which `rows` holds the newest. */
  total: number;
}

const PHASE_WORDS: ReadonlyArray<{ phase: Exclude<Phase, "other">; pattern: RegExp }> = [
  { phase: "plan", pattern: /\b(plan|plans|planner|planning)\b/i },
  { phase: "impl", pattern: /\b(impl|implement|implementation|implementer|coder|coding)\b/i },
  { phase: "review", pattern: /\b(review|reviews|reviewer|reviewing)\b/i },
];

/**
 * A child's phase from its title. The role word that comes first wins, since a
 * brief's title leads with the role: "review the plan for X" is a review.
 */
export function phaseOf(title: string): Phase {
  let best: { phase: Phase; at: number } | null = null;
  for (const { phase, pattern } of PHASE_WORDS) {
    const match = pattern.exec(title);
    if (match !== null && (best === null || match.index < best.at)) best = { phase, at: match.index };
  }
  return best?.phase ?? "other";
}

/** Who did the work: the model, else the provider, else the thread id. */
export function workerName(record: Pick<ArchiveRecord, "threadId" | "model" | "provider">): string {
  return record.model ?? record.provider ?? record.threadId;
}

const SOURCE_TEXT: Record<ArchiveSource, string> = {
  lifecycle: "archived by the lifecycle",
  page: "archived from the page (Archive now)",
  outside: "archived outside the plugin",
};

function issueText(issue: ArchiveRecord["issue"]): string {
  if (issue === null) return "no issue recorded";
  return issue.stateName === null ? issue.identifier : `${issue.identifier} ${issue.stateName}`;
}

/** Why it was archived, in words: who archived it, then the reason the plugin had. */
export function whyText(record: ArchiveRecord): string {
  const head = SOURCE_TEXT[record.source];
  const again = record.archiveCount > 1 ? ` (archived ${record.archiveCount} times)` : "";
  if (record.source === "outside") {
    const seen = record.state === null ? "the lifecycle never saw it" : `last seen ${record.state}: ${record.reason}`;
    return `${capital(head)}${again}; ${seen}.`;
  }
  return `${capital(head)}${again}${record.state === null ? "" : ` as ${record.state}`}: ${record.reason}.`;
}

/** A thread's own fate in one line: its issue as recorded and who archived it. */
export function fateText(record: ArchiveRecord): string {
  return `${issueText(record.issue)}; ${SOURCE_TEXT[record.source]}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function list(names: readonly string[]): string {
  return names.join(", ");
}

/**
 * A driver's roll-up: "planned with opus; 4 rounds of impl (A, B, C, D);
 * reviews by E, F, G; other: H. TEAM-12 Done." Children come oldest first,
 * so the rounds read in order.
 */
export function rollupText(record: ArchiveRecord, children: readonly ArchiveChildView[]): string {
  const by = (phase: Phase) => children.filter((child) => child.phase === phase).map((child) => child.name);
  const parts: string[] = [];
  const plan = by("plan");
  if (plan.length > 0) parts.push(`planned with ${list(plan)}`);
  const impl = by("impl");
  if (impl.length > 0) parts.push(`${impl.length} round${impl.length === 1 ? "" : "s"} of impl (${list(impl)})`);
  const review = by("review");
  if (review.length > 0) parts.push(`review${review.length === 1 ? "" : "s"} by ${list(review)}`);
  const other = by("other");
  if (other.length > 0) parts.push(`other: ${list(other)}`);
  return `${parts.join("; ")}. ${capital(issueText(record.issue))}.`;
}

/** `150k`, or `-` when no usage was recorded, never 0. */
export function tokensOf(count: number | null): string {
  return count === null ? "-" : tokenCount(count);
}

/**
 * Children's tokens summed by phase: `plan 41k, impl 210k, review 66k`. A
 * phase whose children all lack usage shows `-`; a phase where only some do
 * shows the known sum with `+?`, so a missing number stays visibly missing.
 */
export function phaseTokensText(children: readonly ArchiveChildView[]): string {
  const parts: string[] = [];
  for (const phase of PHASES) {
    const inPhase = children.filter((child) => child.phase === phase);
    if (inPhase.length === 0) continue;
    const known = inPhase.filter((child) => child.usedTokens !== null);
    const sum = known.reduce((total, child) => total + child.usedTokens!, 0);
    const text = known.length === 0 ? "-" : `${tokenCount(sum)}${known.length < inPhase.length ? "+?" : ""}`;
    parts.push(`${phase} ${text}`);
  }
  return parts.join(", ");
}

/**
 * The rows of the tab, newest archive first. `records` holds the rows to show
 * and every recorded thread below or above them; `open` maps the threads open
 * in the last lifecycle snapshot to their titles, for a parent that is not
 * archived.
 */
export function composeArchive(shown: readonly string[], records: readonly ArchiveRecord[], open: ReadonlyMap<string, string>, total: number): ArchiveView {
  const byId = new Map(records.map((record) => [record.threadId, record]));
  const childrenOf = new Map<string, ArchiveRecord[]>();
  for (const record of records) {
    if (record.parentThreadId === null) continue;
    childrenOf.set(record.parentThreadId, [...(childrenOf.get(record.parentThreadId) ?? []), record]);
  }
  const below = (id: string): ArchiveRecord[] => {
    const seen = new Set([id]);
    const out: ArchiveRecord[] = [];
    const walk = (parent: string) => {
      for (const child of childrenOf.get(parent) ?? []) {
        if (seen.has(child.threadId)) continue;
        seen.add(child.threadId);
        out.push(child);
        walk(child.threadId);
      }
    };
    walk(id);
    return out.sort((a, b) => (a.startedAt ?? a.archivedAt) - (b.startedAt ?? b.archivedAt) || a.threadId.localeCompare(b.threadId));
  };
  const rows = shown
    .map((id) => byId.get(id))
    .filter((record): record is ArchiveRecord => record !== undefined)
    .sort((a, b) => b.archivedAt - a.archivedAt || a.threadId.localeCompare(b.threadId))
    .map((record): ArchiveRowView => {
      const children = below(record.threadId).map((child) => ({
        threadId: child.threadId,
        title: child.title,
        name: workerName(child),
        phase: phaseOf(child.title),
        fate: fateText(child),
        usedTokens: child.usedTokens,
      }));
      return {
        record,
        why: whyText(record),
        parent: parentOf(record, byId, open),
        children,
        summary: children.length === 0 ? `${capital(fateText(record))}.` : capital(rollupText(record, children)),
        tokens: tokensOf(record.usedTokens),
        phaseTokens: children.length === 0 ? null : phaseTokensText(children),
      };
    });
  return { rows, total };
}

function parentOf(record: ArchiveRecord, byId: ReadonlyMap<string, ArchiveRecord>, open: ReadonlyMap<string, string>): ParentView | null {
  const id = record.parentThreadId;
  if (id === null) return null;
  const archived = byId.get(id);
  if (archived !== undefined) return { threadId: id, status: "archived", title: archived.title };
  const title = open.get(id);
  return title === undefined ? { threadId: id, status: "missing" } : { threadId: id, status: "open", title };
}

/** What a row says about its parent, or null for a thread with none. */
export function parentText(parent: ParentView | null): string | null {
  if (parent === null) return null;
  if (parent.status === "archived") return `Child of ${parent.title || parent.threadId}.`;
  if (parent.status === "open") return `Child of ${parent.title || parent.threadId}, which is still open.`;
  return `Parent ${parent.threadId} is missing: it has no archive record and was not open at the last check.`;
}

/** The realtime channel the server publishes on after it writes an archive row, so an open Archive tab reads it at once. */
export const ARCHIVE_CHANNEL = "archive";
