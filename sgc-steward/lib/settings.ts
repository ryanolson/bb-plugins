// The plugin's settings, as `bb plugin config sgc-steward` and the settings
// page show them.
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
} satisfies Record<string, PluginSettingDescriptor>;
