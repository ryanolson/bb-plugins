// What the page and `bb sgc questions --json` show of the stored rows: the
// stored shapes mapped to the views in the RPC contract.

import type { AskRow, Undelivered, Unposted } from "./ask-store.ts";
import type { AskView, DeliveryView, RecordView } from "./contract.ts";

export function askView(row: AskRow): AskView {
  return {
    id: row.id,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    question: row.question,
    options: row.options,
    issue: row.issue,
    labels: row.labels,
    askedAt: row.askedAt,
  };
}

export function deliveryView(row: Undelivered): DeliveryView {
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    threadId: row.threadId,
    label: row.label,
    state: row.state,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
  };
}

export function recordView(row: Unposted): RecordView {
  return { askId: row.askId, issue: row.issue, state: row.state, error: row.error, attempts: row.attempts };
}
