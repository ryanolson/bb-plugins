// The Paused tab's pure parts: the comment and message of a Resume, the link
// helper that makes Linear links open the app, and the CLI's list.

import { DELIVERY_PREFIX, formatUtc } from "./asks.ts";
import type { ExpiredView, PausedView } from "./contract.ts";

/** The comment a Resume posts as the owner. Its first line names no question block. */
export const RESUMED_HEADER = "Resumed (from the SGC page)";

export function resumeComment(note: string | null): string {
  return note === null ? RESUMED_HEADER : `${RESUMED_HEADER}\n\n${note}`;
}

/** The message that tells the steward an issue was resumed. */
export function resumeMessage(identifier: string, title: string, note: string | null): string {
  const head = `${DELIVERY_PREFIX} Resumed ${identifier}: ${title}`;
  return note === null ? head : `${head}\n${note}`;
}

const LINEAR_WEB = "https://linear.app/";

/**
 * A Linear web link as the Linear app opens it: https://linear.app/<ws>/<rest>
 * becomes linear://<ws>/<rest>. Any other text, a lookalike host included,
 * comes back as it was. Only the page uses this; the CLI keeps https.
 */
export function appLink(url: string): string {
  return url.startsWith(LINEAR_WEB) && url.length > LINEAR_WEB.length ? `linear://${url.slice(LINEAR_WEB.length)}` : url;
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
