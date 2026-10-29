// Plain text for questions: the one-line preview in notifications, the
// `bb sgc questions` listing, and the `--block` option that listing prints.
import { PluginCliError } from "@get-bb/plugin-sdk";
import { formatUtc } from "./asks.ts";
import type { Panel, TodoView } from "./contract.ts";
import type { BlockRef, QuestionBlock } from "./questions.ts";

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function preview(block: QuestionBlock): string {
  if (block.format === "parsed") return truncate(firstLine(block.questions[0]?.text ?? ""), 160);
  const lines = block.body.trimStart().split("\n");
  const rest = lines[0]!.replace(/^\[agent:[^\]]*\]\s*/, "");
  return truncate(firstLine([rest, ...lines.slice(1)].join("\n")), 160);
}

/** `--block <comment id>@<revision>`, as `bb sgc questions` prints it. */
export function parseBlockOption(value: string): BlockRef {
  const at = value.lastIndexOf("@");
  const blockId = value.slice(0, at);
  const revision = value.slice(at + 1);
  if (at <= 0 || !/^[0-9a-f]{12}$/.test(revision)) {
    throw new PluginCliError(`--block ${value} is not <comment id>@<revision>.`, {
      code: "invalid_block",
      hint: "Copy the block from `bb sgc questions`, like q1@3fa2c9d01b7e.",
    });
  }
  return { blockId, revision };
}

function formatBlock(block: QuestionBlock): string[] {
  const asker = `${block.agent}${block.threadId === null ? "" : ` ${block.threadId}`}`;
  const ref = `block ${block.commentId}@${block.revision}`;
  if (block.format === "raw") {
    const body = truncate(block.body.trim(), 4000).split("\n").map((line) => `    | ${line}`);
    return [`  Question from ${asker} (${ref}), not in the question format (${block.problem}):`, ...body];
  }
  const lines = [`  Questions ${block.date ?? block.createdAt.slice(0, 10)} from ${asker} (${ref})`];
  if (block.context !== "") lines.push(...block.context.split("\n").map((line) => `  ${line}`));
  for (const question of block.questions) {
    const [head, ...more] = question.text.split("\n");
    lines.push(`  Q${question.number}. ${head}`, ...more.map((line) => `      ${line}`));
    for (const option of question.options) {
      const [text, ...rest] = option.text.split("\n");
      lines.push(`      ${option.letter}${option.recommended ? " (recommended)" : ""}: ${text}`, ...rest.map((line) => `        ${line}`));
    }
  }
  return lines;
}

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The panel as text. With `labels`, the view lists only bb questions that have them all, and Linear is left out. */
export function formatPanel(view: Panel, labels: readonly string[] = []): string {
  const lines: string[] = [];
  if (view.configured && labels.length === 0) {
    if (view.issues.length === 0) lines.push(`No open questions on ${view.teamKey} issues.`);
    for (const issue of view.issues) {
      lines.push(`${issue.identifier}  ${issue.title}  [${issue.kind === "checkin" ? "check-in" : "needs-decision"}]`);
      for (const block of issue.blocks) lines.push(...formatBlock(block));
      const blocks = issue.blocks.map((block) => `--block ${block.commentId}@${block.revision}`).join(" ");
      lines.push(`  Answer: bb sgc answer ${issue.identifier} ${blocks} --text-file <file>`, "");
    }
  }
  if (view.asks.length === 0) {
    lines.push(labels.length === 0 ? "No open bb questions." : `No open bb questions with the label${labels.length === 1 ? "" : "s"} ${andList(labels)}.`);
  }
  for (const ask of view.asks) {
    const tags = ask.labels.length === 0 ? "" : `, labels ${ask.labels.join(", ")}`;
    lines.push(`${ask.id}  from ${ask.threadTitle || ask.threadId} (${ask.threadId}), asked ${formatUtc(ask.askedAt)}${ask.issue === null ? "" : `, issue ${ask.issue}`}${tags}`);
    lines.push(...ask.question.split("\n").map((line) => `  ${line}`));
    for (const option of ask.options) lines.push(`    ${option.letter}${option.recommended ? " (recommended)" : ""}: ${option.text}`);
    lines.push("  Answer it on the SGC questions page.", "");
  }
  if (view.undelivered.length > 0) {
    lines.push("Answers not delivered:");
    for (const row of view.undelivered) {
      lines.push(`  ${row.label} to ${row.threadId}: ${row.error ?? "not sent yet"} (${row.attempts} ${row.attempts === 1 ? "try" : "tries"})`);
    }
    lines.push("  Retry them on the SGC questions page.", "");
  }
  if (view.unposted.length > 0) {
    lines.push("Records not posted to Linear:");
    for (const row of view.unposted) lines.push(`  ${row.askId} on ${row.issue}: ${row.error ?? "not posted yet"}`);
    lines.push("  Retry them on the SGC questions page.", "");
  }
  for (const failed of view.issueErrors) lines.push(`Could not read ${failed.identifier}: ${failed.message}`);
  return lines.join("\n").trim();
}

/** What a steward withdrawal did, as `bb sgc withdraw` prints it. */
export interface WithdrawalResult {
  id: string;
  withdrawn: true;
  notice: "sent" | "failed" | "skipped";
  record: "none" | "posted" | "failed";
}

export function withdrawalReport(result: WithdrawalResult, asker: string, sendError: string | null, issue: string | null, recordError: string | null): string {
  const told = {
    sent: `Told ${asker}.`,
    failed: `Could not tell ${asker}: ${sendError ?? "unknown error"}. Retry it on the SGC questions page.`,
    skipped: `Did not tell ${asker}: the thread is archived or gone.`,
  }[result.notice];
  const recorded = {
    none: [],
    posted: [`Recorded it on ${issue}.`],
    failed: [`Could not record it on ${issue}: ${recordError ?? "unknown error"}. Retry it on the SGC questions page.`],
  }[result.record];
  return [`Withdrew ${result.id}.`, told, ...recorded].join("\n");
}

/** The todos as `bb sgc todos` prints them: each with its link and its task lines. */
export function formatTodos(todos: readonly TodoView[]): string {
  if (todos.length === 0) return "No todos.";
  const lines: string[] = [];
  for (const todo of todos) {
    lines.push(`${todo.identifier}  ${todo.title}${todo.human ? "  [human]" : ""}`, `  ${todo.url}`);
    for (const step of todo.steps) lines.push(`  [${step.done ? "x" : " "}] ${step.text}`);
    lines.push("");
  }
  lines.push("Done: bb sgc todo done <issue> [--note <text>]");
  return lines.join("\n");
}
