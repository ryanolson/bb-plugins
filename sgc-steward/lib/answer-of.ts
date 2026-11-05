// `bb sgc answer-of`: how a bb question was answered, read from the plugin's
// own row and nothing else. A tool that gates an action on the owner's
// answer reads this, not Linear, where any agent can post as the owner.

import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { AskRow, AskState, AskStore } from "./ask-store.ts";
import type { AnswerChannel } from "./asks.ts";

/**
 * What `bb sgc answer-of --json` prints of one bb question: only the
 * plugin's stored row, never Linear. Every answer field is null unless the
 * question is answered.
 */
export interface AnswerOf {
  id: string;
  /** The asking thread. */
  threadId: string;
  issue: string | null;
  /** The question exactly as stored. */
  question: string;
  options: Array<{ letter: string; text: string }>;
  status: AskState;
  /** RFC 3339, UTC. */
  answeredAt: string | null;
  channel: AnswerChannel | null;
  /** The picked option; null for a free-text answer. */
  option: { letter: string; text: string } | null;
  /** The typed answer, or the note under the picked option; null when there is none. */
  text: string | null;
}

/** Throws when a stored answer names an option the question does not have, so a check never reads it as free text. */
export function answerOf(row: AskRow): AnswerOf {
  const options = row.options.map(({ letter, text }) => ({ letter, text }));
  const answer = row.state === "answered" ? row.answer : null;
  let option: AnswerOf["option"] = null;
  if (answer !== null && answer.option !== null) {
    option = options.find((candidate) => candidate.letter === answer.option) ?? null;
    if (option === null) throw new Error(`${row.id} has an answer for option ${answer.option}, which it does not have`);
  }
  const note = answer === null ? "" : answer.text.trim();
  return {
    id: row.id,
    threadId: row.threadId,
    issue: row.issue,
    question: row.question,
    options,
    status: row.state,
    answeredAt: answer !== null && row.answeredAt !== null ? new Date(row.answeredAt).toISOString() : null,
    channel: answer === null ? null : row.answerChannel,
    option,
    text: note === "" ? null : note,
  };
}

/** The plain-text form: one line for the question, then the answer as given. */
export function answerOfText(view: AnswerOf): string {
  if (view.status !== "answered") return `${view.id} from ${view.threadId}: ${view.status}, not answered`;
  const picked = view.option === null ? null : `${view.option.letter}: ${view.option.text}`;
  return [
    `${view.id} from ${view.threadId}: answered ${view.answeredAt} through ${view.channel ?? "an unknown channel"}`,
    ...[picked, view.text].filter((part) => part !== null),
  ].join("\n");
}

export function answerOfCommand(asks: Pick<AskStore, "get">) {
  return cliCommand({
    summary: "Show how a bb question was answered, from the plugin's own record",
    description:
      "Reads only the plugin's stored question, never Linear, so a Linear comment cannot change what it prints. Exits 0 for a known id, open, answered, or withdrawn, and 1 for an unknown one. channel bb means the answer came through the plugin's answer RPC, which the page calls; bb cannot tell the owner from an agent calling that RPC.",
    positionals: [{ name: "id", description: "Question id, like bbq_k3x9mz2p4q", required: true }],
    options: { json: { type: "boolean", description: "Print machine-readable JSON" } },
    async run(input) {
      const row = asks.get(input.positionals.id);
      if (row === null) throw new PluginCliError(`No bb question ${input.positionals.id}.`, { code: "not_found" });
      const view = answerOf(row);
      return { exitCode: 0, stdout: input.options.json ? JSON.stringify(view) : answerOfText(view) };
    },
  });
}
