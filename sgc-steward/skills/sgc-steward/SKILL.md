---
name: sgc-steward
description: Ask the owner a question without blocking your thread, with `bb sgc ask`. Treat the `[sgc-steward] Answer to` message that comes back as the answer, and `[sgc-steward] Withdrawn` as the end of the question. Also the question format for Linear check-in issues, how the steward withdraws stale questions, the messages the steward gets when the owner finishes a todo, and the `bb sgc` commands. Use whenever you need a decision from the owner, when you are the steward agent writing check-in questions or retracting stale ones, when you park a question with the needs-decision label, or when the user asks about open questions.
---

# SGC Steward questions

The SGC Steward plugin shows your questions to the owner on a page in bb and sends the answers back to your thread.

Never ask the owner in a bb question dialog. It stops your thread until the owner answers, and every thread waiting on you stops too.

## Asking from a bb thread

```
bb sgc ask --question "<question>" --option "<your recommendation>" --option "<another answer>" [--issue TEAM-12]
```

- The command stores the question, prints its id, and returns at once. Then move on to other work.
- The answer arrives in your thread as a message that starts with `[sgc-steward] Answer to <id>`. It quotes your question and the owner's answer word for word. Treat it as the owner's answer.
- Put your recommendation first: option A is marked recommended. Pass `--recommend B` to mark another, or `--recommend none`.
- Use `--question-file <file>` for a long question.
- Name an issue with `--issue` when the answer is a ruling that belongs in Linear. The plugin then posts a comment there that records the question and the answer.
- Asking the same open question again returns the same id. Withdraw a question you no longer need with `bb sgc withdraw <id>`, from the thread that asked it.
- The steward can withdraw your question when it is no longer valid. You then get a message that starts with `[sgc-steward] Withdrawn <id>`, with the reason. Stop waiting for that answer, and ask again only if the question still matters.
- A thread can have 10 open questions at a time.

## Withdrawing stale questions

The steward thread, named in the plugin's `stewardThread` setting, withdraws any open bb question that is no longer valid: its issue closed, a later question replaced it, or events decided it. It calls the `sgc_withdraw_question` agent tool with the question id and the reason.

- The tool refuses every thread but the steward. `bb sgc withdraw` withdraws only the calling thread's own questions, even in the steward thread.
- The steward must give a reason. The asking thread gets it in a message that starts with `[sgc-steward] Withdrawn <id>`, unless bb reports that thread archived, deleted, or missing.
- When the question names an issue, the plugin posts a record of the withdrawal there. The record closes no Linear block.
- The tool reaches the steward when its agent session next starts after the setting is made.

## The owner's todos

The plugin lists the owner's todos on the SGC page and with `bb sgc todos`: open issues on the team with the `waiting:ryan-action` label, and the owner's own issues with the `human` label. Use `waiting:ryan-action` only for an action only the owner can take, such as logging in on a machine, giving a token, or approving a budget. A decision belongs in `bb sgc ask` or a question block.

When the owner marks a todo done, on the page or with `bb sgc todo done`, the plugin:

- posts the owner's comment `Done (from the SGC page)` on the issue, with the owner's note if there is one;
- moves a `human` issue to the team's Done state, or removes `waiting:ryan-action` from any other issue and leaves its state;
- sends the steward thread a queued message that starts with `[sgc-steward] Todo done <issue>: <title>`, with the note on the next line.

Treat that message as the owner's word that the action is done, and go on with the work behind it. A message that starts with `[sgc-steward] Todo reopened <issue>: <title>` takes it back: the todo is open again. Messages about one issue arrive in the order the owner acted, so the latest one stands.

## Asking on a Linear check-in issue

The steward posts each set of questions as one signed comment on the check-in issue:

```
[agent:<tool> <your thread id>] Questions YYYY-MM-DD

Optional context goes before the first question.

Q1. <question>
- A (recommended): <option>
- B: <option>

Q2. <question with no options; the owner types the answer>
```

- Leave a blank line after the first line, after the context, and after each question's options. Linear stores comments as rich text and can fold a line that sits right under an option into that option.
- Start each question on its own line with `Q1.`, `Q2.`, and so on, in order.
- List options under their question as `- A:`, `- B:`, and so on, in order.
- Mark at most one option per question `(recommended)`.
- Put every option on one line. Indent a line that continues an option.
- Put context before `Q1.`, not after the options.
- Put your bb thread id in the signature. The answer is then also sent to your thread, as a message that starts with `[sgc-steward] Answer to your questions on <issue>`.
- Do not edit a block after you post it. Post a new block instead. An edit changes the block's revision, so an answer to the old text no longer closes it, and the owner is notified again.

A comment that breaks a rule is still shown, but as plain text without option buttons.

On a needs-decision issue, the latest signed comment is the question. Use the same format there when the question has options.

## Reading a Linear answer

- An answer from the SGC Steward page or `bb sgc answer` names the blocks it answers in its header lines, as `(block <comment id> rev <revision>)`. It answers only those blocks, at that revision. Ask again about any block it does not name.
- A comment that starts with `Answer to bb question` records the answer to a bb question, or its withdrawal. It answers no Linear block.
- A comment whose first line is `Done (from the SGC page)` or `Reopened (from the SGC page)` marks a todo done or open again. It answers no Linear block either.
- Any other unsigned comment from the owner answers every block before it.
- The page writes `Q1. A: <option text>` for a picked option, `Q2. <text>` for a typed answer, and `Q3. No answer.` for a skipped question. A note can follow on the next line.
- Ask again in a new block for every question marked `No answer.` that still matters.

## Commands

```
bb sgc ask --question <text> | --question-file <file> [--option <text>]... [--recommend <letter|none>] [--issue <TEAM-12>] [--thread <id>] [--json]
bb sgc withdraw <id> [--reason <text>] [--thread <id>] [--json]
bb sgc questions [--json] [--cached]
bb sgc todos [--json] [--cached]
bb sgc todo done <issue> [--note <text>] [--json]
bb sgc answer <issue> --block <id>@<revision> --text-file <file> [--machine <name-or-id>] [--json]
```

- `bb sgc questions` lists the open questions, both kinds, with the recommended option first, and each Linear block as `<comment id>@<revision>`.
- `bb sgc answer` posts one unsigned comment on a Linear issue: a header that names each `--block`, then the file's text. Pass every open block of the issue, as `bb sgc questions` prints it. Linear then treats it as the owner's answer. Use it only to relay the owner's own words, never your own judgment.
- Number the relayed answers to match: `Q1. A`, `Q2. <text>`.
- `bb sgc answer` refuses text that starts with `[agent:`, and issues with no open questions.
- `bb sgc todo done` marks a todo done as the owner, and the steward treats its message as the owner's word. Run it only to relay the owner's own word that the action is done, never on your own judgment.
