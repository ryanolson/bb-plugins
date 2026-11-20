// The Paused tab's pure parts: the comment and message of a Resume, and the
// CLI's list. Server side only: the page must not import this file (see
// links.ts and the README's Coding gotchas).

import { DELIVERY_PREFIX, formatUtc } from "./asks.ts";
import { RESUMED_HEADER } from "./questions.ts";
import type { ExpiredView, PausedView } from "./contract.ts";

/** The comment a Resume posts as the owner. Its first line names no question block, and `answeredBlocks` knows it. */

export function resumeComment(note: string | null): string {
  return note === null ? RESUMED_HEADER : `${RESUMED_HEADER}\n\n${note}`;
}

/** The message that tells the steward an issue was resumed. */
export function resumeMessage(identifier: string, title: string, note: string | null): string {
  const head = `${DELIVERY_PREFIX} Resumed ${identifier}: ${title}`;
  return note === null ? head : `${head}\n${note}`;
}

/** What `bb sgc paused` prints: the paused issues, then the questions that expired. */
export function formatPaused(paused: readonly PausedView[], expired: readonly ExpiredView[], error: string | null): string {
  const lines: string[] = [];
  if (paused.length === 0) lines.push("No paused issues.");
  for (const issue of paused) {
    lines.push(`${issue.identifier}  ${issue.title}${issue.state === null ? "" : `  [${issue.state}]`}`, `  ${issue.url}`);
  }
  if (error !== null) lines.push("", `Could not read the paused issues: ${error}`);
  if (expired.length > 0) {
    lines.push("", "Expired with no answer, in the last 14 days:");
    for (const ask of expired) {
      lines.push(`${ask.id}  from ${ask.threadTitle || ask.threadId} (${ask.threadId}), expired ${formatUtc(ask.expiredAt)}${ask.issue === null ? "" : `, issue ${ask.issue}`}`);
      lines.push(`  ${ask.question.split("\n")[0]}`);
    }
  }
  if (paused.length > 0) lines.push("", "Resume: bb sgc resume <issue> [--note <text>]");
  return lines.join("\n");
}
