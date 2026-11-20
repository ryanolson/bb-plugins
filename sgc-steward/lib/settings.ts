// The plugin's settings, as `bb plugin config sgc-steward` and the settings
// page show them.
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cacheLifeOverridesProblem, lifecycleActionsProblem } from "./lifecycle.ts";

/** The agent tool the steward withdraws other threads' questions with. */
export const WITHDRAW_TOOL = "sgc_withdraw_question";

export const SETTINGS = {
  linearApiKey: {
    type: "string",
    label: "Linear API key",
    description: "A personal Linear API key that can read the team's issues and post comments. Kept as a secret on the bb server.",
    secret: true,
    // A key that is not a valid header value would be quoted back by the
    // runtime's header error, so it is refused on save.
    experimental_schema: z.string().regex(/^[\x21-\x7e]+$/, "Paste only the key: no spaces, line breaks, or other control characters."),
  },
  teamKey: {
    type: "string",
    label: "Linear team key",
    description: "The team whose check-in and needs-decision issues hold the questions.",
    default: "STRGT",
    experimental_schema: z.string().regex(/^[A-Z0-9]{1,16}$/, "Use the team key, like ENG"),
  },
  pollMinutes: {
    type: "number",
    label: "Poll interval (minutes)",
    description: "How often to read Linear for new questions.",
    default: 5,
    experimental_schema: z.number().int().min(1).max(1440),
  },
  notify: {
    type: "boolean",
    label: "Notify on new questions",
    description: "Show a notification in bb, once per question block, when new questions arrive.",
    default: true,
  },
  stewardThread: {
    type: "string",
    label: "Steward thread",
    description: `The bb thread id of the steward, which may withdraw any open bb question, with a reason, through the ${WITHDRAW_TOOL} agent tool, and which gets a message when the owner marks a todo done or reopens it. Unset, each thread withdraws only its own, and no todo messages are sent.`,
    experimental_schema: z.string().regex(/^thr_[a-z0-9]+$/, "Use a bb thread id, like thr_abc123"),
  },
  threadLifecycleMode: {
    type: "select",
    label: "Thread lifecycle mode",
    description:
      "observe: the plugin decides what to do with each thread before its prompt cache expires, and only logs it. act: it also archives finished and parked threads, compacts large active ones, and tells the steward about stuck ones.",
    options: ["observe", "act"],
    default: "observe",
  },
  lifecycleActions: {
    type: "string",
    label: "Thread lifecycle actions",
    description: "In act mode, which actions are on: archive-done, archive-parked, and compact, separated by commas. A decision for an action that is off is only logged.",
    default: "archive-done,archive-parked,compact",
    experimental_schema: z.string().superRefine((text, ctx) => {
      const problem = lifecycleActionsProblem(text);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    }),
  },
  cacheLifeOverrides: {
    type: "string",
    label: "Cache life overrides (minutes)",
    description: "How long a provider keeps a thread's prompt cache, when bb gives no expiry: provider=minutes, separated by commas, like pi=360,claude-code=60. Providers not listed use the built-in table: claude-code and codex 60, pi and acp-opencode 360, others 60.",
    default: "",
    experimental_schema: z.string().superRefine((text, ctx) => {
      const problem = cacheLifeOverridesProblem(text);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    }),
  },
} satisfies Record<string, PluginSettingDescriptor>;
