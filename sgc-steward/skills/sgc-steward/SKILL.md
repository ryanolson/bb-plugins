---
name: sgc-steward
description: Ask the owner a question without blocking your thread, with `bb sgc ask`. Treat the `[sgc-steward] Answer to` message that comes back as the answer, and `[sgc-steward] Withdrawn` as the end of the question. Also the question format for Linear check-in issues, how the steward withdraws stale questions, the messages the steward gets when the owner finishes a todo, and the `bb sgc` commands. Use whenever you need a decision from the owner, when you are the steward agent writing check-in questions or retracting stale ones, when you park a question with the needs-decision label, or when the user asks about open questions.
---

# SGC Steward questions

The SGC Steward plugin shows your questions to the owner on a page in bb and sends the answers back to your thread.

Never ask the owner in a bb question dialog. It stops your thread until the owner answers, and every thread waiting on you stops too.

## Asking from a bb thread

```
bb sgc ask --question "<question>" --option "<your recommendation>" --option "<another answer>" [--issue TEAM-12] [--urgent] --label "<project name>"
```

- The command stores the question, prints its id, and returns at once. Then move on to other work.
- The answer arrives in your thread as a message that starts with `[sgc-steward] Answer to <id>`. It quotes your question and the owner's answer word for word. Treat it as the owner's answer.
- Put your recommendation first: option A is marked recommended. Pass `--recommend B` to mark another, or `--recommend none`.
- Use `--question-file <file>` for a long question.
- The question and its options may use Markdown: lists, tables, inline code, code blocks, bold, and links all render on the page. Raw HTML never runs. A table needs a delimiter row, such as `| --- | --- |`, right under its header row. Without it, the table shows as plain text, and `bb sgc ask` prints a line that starts with `Warning:` (with `--json`, a `warnings` list). The question is still stored: withdraw it with `bb sgc withdraw <id>` and ask again with the fixed table.
- Keep it short. The question is at most 80 words, with 1 to 3 options of at most 25 words each. `bb sgc ask` refuses more, with code `invalid` and the limit in the message. Put detail on the issue and link it with `--issue`.
- Give the question exactly one label: `--label "<project name>"`, the name of the issue's Linear project, in any case. Zero labels, two labels, or a name that is not an open project of the team are refused. Until the plugin has read the project names from Linear, any label is taken and the command prints a `Warning:` line. Asking the same open question again keeps its first label.
- A question expires if nobody answers: after 3 days, or after 1 day with `--urgent` (use it only when the work cannot wait). Then you get a message that starts with `[sgc-steward] Expired <id>`. It means pause the work: commit, push, and check that the remote branch matches HEAD; comment `paused: no answer by <date>` on the issue with the branch and commit; release your claim; move the issue to Backlog with the `paused` label; and archive your thread after the save. The steward thread does not archive. An expired question takes no answer. If the question named an issue, the plugin records the expiry there.
- Every question gets a last option you did not write: "Pause it: stop this work for now, and resume it later." It is never recommended and counts against no limit. If the owner picks it, the answer reaches you like any other: save your work, and stop.
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

## Paused work

The SGC page has a Paused tab, and `bb sgc paused [--json] [--cached]` prints the same lists: open issues on the team with the `paused` label, newest change first, and the bb questions that expired with no answer in the last 14 days. An agent puts an issue there when it pauses work for want of an answer (see "Expired" above), and the owner can pause work too. When the owner resumes an issue, on the page or with `bb sgc resume <issue> [--note <text>]`, the plugin:

- posts the owner's comment `Resumed (from the SGC page)` on the issue, with the owner's note if there is one;
- removes the `paused` label and moves the issue to the team's Todo state;
- sends the steward thread a queued message that starts with `[sgc-steward] Resumed <issue>: <title>`, with the note on the next line.

Work restarts from the branch and commit named in the `paused: no answer by <date>` comment, so a resumed issue goes back through Todo and the normal claim. Linear links on the page open the Linear app (`linear://`); CLI output keeps `https://` links.

## The owner's todos

The plugin lists the owner's todos on the SGC page and with `bb sgc todos`: open issues on the team with the `waiting:ryan-action` label, and the owner's own issues with the `human` label. Use `waiting:ryan-action` only for an action only the owner can take, such as logging in on a machine, giving a token, or approving a budget. A decision belongs in `bb sgc ask` or a question block.

When the owner marks a todo done, on the page or with `bb sgc todo done`, the plugin:

- posts the owner's comment `Done (from the SGC page)` on the issue, with the owner's note if there is one;
- moves a `human` issue to the team's Done state, or removes `waiting:ryan-action` from any other issue and leaves its state;
- sends the steward thread a queued message that starts with `[sgc-steward] Todo done <issue>: <title>`, with the note on the next line.

Treat that message as the owner's word that the action is done, and go on with the work behind it. A message that starts with `[sgc-steward] Todo reopened <issue>: <title>` takes it back: the todo is open again. Messages about one issue go out in the order the owner acted, but one the owner resent from the SGC page arrives late. When two messages about one issue disagree, read the issue in Linear.

## Asking on a Linear check-in issue

The steward posts each set of questions as one signed comment on the check-in issue:

```
[agent:<tool> <your thread id>] Questions YYYY-MM-DD

Optional context goes before the first question.

Q1. <question>
- A (recommended): <option>
- B: <option>

Q2. <question>
- A (recommended): <option>
```

- Leave a blank line after the first line, after the context, and after each question's options. Linear stores comments as rich text and can fold a line that sits right under an option into that option.
- Start each question on its own line with `Q1.`, `Q2.`, and so on, in order.
- Give every question 1 to 3 options, listed under it as `- A:`, `- B:`, and so on, in order. The page adds a last option, Pause, for you; a question with all 26 letters in use gets none, rather than a letter past Z.
- Mark at most one option per question `(recommended)`.
- Put every option on one line. Indent a line that continues an option.
- Markdown renders here too, but the format drops blank lines and indentation inside a question. A table (with its `| --- |` delimiter row), a flat list, and a code block still render. Put nested lists or indented code in a `bb sgc ask` question instead.
- Put context before `Q1.`, not after the options.
- Ask one question per block. The owner answers each question on its own card, and a block with several stays open until each has an answer.
- Put your bb thread id in the signature. The answer is then also sent to your thread, as a message that starts with `[sgc-steward] Answer to your questions on <issue>`. A block with several questions gets one such message per answer, each with only the questions it answers.
- Do not edit a block after you post it. Post a new block instead. An edit changes the block's revision, so an answer to the old text no longer closes it, and the owner is notified again.

A comment that breaks a rule is still shown, as written, and answered by the note or by Pause; it has no options of its own.

On a needs-decision issue, the latest signed comment is the question. Use the same format there when the question has options.

## Reading a Linear answer

- An answer from the SGC Steward page or `bb sgc answer` names what it answers in its header lines. `(block <comment id> rev <revision>)` answers that whole block, at that revision. `(block <comment id> rev <revision>), Q2` answers only question 2 of it: the block stays open until each of its questions has an answer, in this comment or a later one. Ask again about any block it does not name.
- A line that starts with `>` in an answer is the owner's own text, quoted by the plugin: read it as the owner's words. The plugin quotes every line of it, and an empty line is `>`. A quoted line answers nothing, even when it reads like a header.
- To see what is still open, run `bb sgc questions`. It lists only the questions that have no answer yet.
- A comment that starts with `Answer to bb question` records the answer to a bb question, or its withdrawal. It answers no Linear block.
- A comment whose first line is `Done (from the SGC page)` or `Reopened (from the SGC page)` marks a todo done or open again. It answers no Linear block either.
- Any other unsigned comment from the owner answers every block before it.
- The page answers one question per comment. It writes `Q1. A: <option text>` for a picked option, and `Q2.` alone on its line for a typed answer. The owner's text, a note under the option or the typed answer, follows below as quoted lines:

  ```
  Q1. A: <option text>
  > <the owner's note>

  Q2.
  > <the owner's typed answer>
  ```

- An answer from before this format can hold the typed text on the number's line, an unquoted note, or `Q3. No answer.` for a question the owner skipped.
- Ask again in a new block for every question marked `No answer.` that still matters.

## Thread lifecycle

The plugin watches every thread and decides, before each thread's prompt cache expires, whether to keep it, compact it, or archive it. It starts in observe mode, and only the owner switches it to act (`threadLifecycleMode`). In act mode it archives finished and parked threads and compacts large active ones, posts `[agent:sgc-steward] archived <thread>: ...` on the issue first, and, if you are the steward, sends you `[sgc-steward] Thread <id> stuck: <reason>` at most once a day per thread: check that thread, and say so on its issue if it needs the owner. `bb sgc threads` lists each thread with its state, issue, provider and model, tokens, cache expiry, decision, and reason. `bb sgc threads log` shows what it decided. Mission Control, the steward, and pinned threads are `protected`. The Threads tab on the SGC page shows the same, with the decision log, and Keep, Compact now, and Archive now buttons for the owner. To keep a thread out of an archive, pin it in bb.

To make a thread findable, claim its issue with a signed `claim:` comment, or start its title with `<TEAM>-NNNN` or `NNNN:`. A thread with no issue for 24 hours is an `orphan`, and the steward gets flagged.

## Commands

```
bb sgc ask --question <text> | --question-file <file> --option <text> [--option <text>]... [--recommend <letter|none>] [--issue <TEAM-12>] [--urgent] --label <project name> [--thread <id>] [--json]
bb sgc withdraw <id> [--reason <text>] [--thread <id>] [--json]
bb sgc questions [--json] [--cached] [--label <name>]... [--match any|all]
bb sgc answer-of <id> [--json]
bb sgc todos [--json] [--cached]
bb sgc paused [--json] [--cached]
bb sgc resume <issue> [--note <text>] [--json]
bb sgc todo done <issue> [--note <text>] [--json]
bb sgc answer <issue> --block <id>@<revision> --text-file <file> [--machine <name-or-id>] [--json]
bb sgc hosts [--digest] [--json]
bb sgc threads [--json] [--cached]
bb sgc threads log [--limit <n>] [--json]
```

- `bb sgc questions` lists the open questions, both kinds, with the recommended option first, and each Linear block as `<comment id>@<revision>`. `--label <name>` lists only the questions with that label. Give it again for more: a question then needs any one of them, or every one with `--match all`. A Linear question carries its issue's labels, a label in a label group as `group/name`, such as `area/gdl`.
- `bb sgc answer-of <id> --json` prints a bb question as the plugin stored it: `status` (`open`, `answered`, `withdrawn`), `answeredAt`, `channel`, the picked `option` (`{letter, text}`, or `null` for a typed answer), and `text`. It never reads Linear, so check an answer with it, not with a Linear comment. `channel` `bb` means the plugin's answer RPC stored it; bb cannot tell the owner from an agent that calls that RPC. It exits 1 for an unknown id.
- `bb sgc answer` posts one unsigned comment on a Linear issue: a header that names each `--block`, then the file's text, quoted line by line. Pass each block the text answers, as `bb sgc questions` prints it. It answers each named block whole, so cover every question still open in it. Linear then treats it as the owner's answer. Use it only to relay the owner's own words, never your own judgment.
- Number the relayed answers to match: `Q1. A`, `Q2. <text>`.
- `bb sgc answer` refuses text that starts with `[agent:`, and issues with no open questions.
- `bb sgc hosts` shows each host: running and idle threads, the turns waiting on bb's concurrency limit with the oldest wait, and the limit, `override` or `automatic`. The steward runs `bb sgc hosts --digest` for its digest: the hosts at their limit, and the hosts with waiting turns and the oldest wait. `--json` gives `atLimit` and `waiting`. It only reads. Change a limit with `bb concurrency-limit host` only on the owner's word. It exits 1 when the limits could not be read, and the counts still show.
- `bb sgc todo done` marks a todo done as the owner, and the steward treats its message as the owner's word. Run it only to relay the owner's own word that the action is done, never on your own judgment.
