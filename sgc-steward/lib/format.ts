// Plain text for questions: the one-line preview in notifications, the
// `bb sgc questions` listing, and the `--block` option that listing prints.
import { PluginCliError } from "@get-bb/plugin-sdk";
import { formatUtc } from "./asks.ts";
import type { Panel } from "./contract.ts";
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

export function formatPanel(view: Panel): string {
  const lines: string[] = [];
  if (view.configured) {
    if (view.issues.length === 0) lines.push(`No open questions on ${view.teamKey} issues.`);
    for (const issue of view.issues) {
      lines.push(`${issue.identifier}  ${issue.title}  [${issue.kind === "checkin" ? "check-in" : "needs-decision"}]`);
      for (const block of issue.blocks) lines.push(...formatBlock(block));
      const blocks = issue.blocks.map((block) => `--block ${block.commentId}@${block.revision}`).join(" ");
      lines.push(`  Answer: bb sgc answer ${issue.identifier} ${blocks} --text-file <file>`, "");
    }
  }
  if (view.asks.length === 0) lines.push("No open bb questions.");
  for (const ask of view.asks) {
    lines.push(`${ask.id}  from ${ask.threadTitle || ask.threadId} (${ask.threadId}), asked ${formatUtc(ask.askedAt)}${ask.issue === null ? "" : `, issue ${ask.issue}`}`);
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
