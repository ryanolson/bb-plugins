# bb-plugin-sgc-steward

A steward agent asks you questions as signed comments on Linear check-in issues. Linear does not notify you about them, because every agent posts through your own login. This plugin finds the open questions, shows them on a page in bb, notifies you once per question block, and posts your answers back to Linear. The agent's thread never waits on a dialog.

## Install

```
bb plugin install git:https://github.com/ryanolson/bb-plugins.git --subdirectory sgc-steward
<command that prints your Linear API key> | bb sgc key --api-key-stdin
```

The key goes to the plugin's secret settings on the bb server and is never printed. You can also paste it in Settings, Installed plugins, SGC Steward. Until the key is set, the plugin reads nothing and the page says how to set it.

## Question format

The steward writes each set of questions as one signed comment:

```
[agent:claude-code thr_abc123] Questions 2026-01-05

Optional context goes before the first question.

Q1. Which scale do estimates use?
- A (recommended): Powers of two: 1, 2, 4, 8.
- B: Small, medium, large.

Q2. Which project goes first?
- A: The router.
- B (recommended): The cells.

Q3. Anything else before the next run?
```

- The first line is the signature, then `Questions` and the date.
- A blank line follows the first line, the context, and each question's options. Linear stores comments as rich text, and a line right under an option can come back as part of that option.
- Each question starts a line with `Q1.`, `Q2.`, and so on, in order.
- Options follow their question as `- A:`, `- B:`, and so on, in order. `*` and `+` bullets also work.
- At most one option per question is marked `(recommended)`. The page shows it first.
- A question with no options takes a typed answer.
- Any other line continues the question above it. An indented line continues the option above it.

The page shows a comment that breaks these rules as written, with the reason, and takes a typed answer for it.

## When a question is open

- A signed comment starts with `[agent:`. Any other comment from a user is your answer. Comments from integrations are neither.
- On a check-in issue (label `checkin`), a signed comment is a question block when it has a `Q1.` line or a bare `Questions` header. Run reports and digests stay out. A block is open until an unsigned comment comes after it. A reply in a comment thread counts.
- On a needs-decision issue (label `needs-decision`), the latest signed comment is the question, in any shape. It is open while the issue has the label and no unsigned comment came after it.
- Completed and canceled issues are skipped.

## Answer format

Your first unsigned comment closes every open block on the issue, so one comment answers them all. The page writes it like this:

```
Answers to the questions of 2026-01-05

Q1. A: Powers of two: 1, 2, 4, 8.

Q2. B: The cells.
Start with the cells project.

Q3. No answer.
```

A picked option gives its letter and its text, and a note goes on the next line. A typed answer follows the number. When one comment answers several blocks, each block gets a header with the time it was posted. Answering a needs-decision issue also removes the label.

## How it works

A service on the bb server polls Linear every `pollMinutes`. It lists the team's open issues that have the `checkin` or `needs-decision` label. It reads an issue's comments again only when the issue changed, and every issue once an hour. When Linear returns comments newest first, it stops at the first unsigned comment. Polls and answers run one at a time. Before it posts, it reads the issue again and refuses when the open blocks changed, so an answer never closes a question you did not see.

## Notifications

When a poll finds a new question block, every open bb window hears about it. The first window to ask for it gets it, so each block is announced once. Blocks found in the same poll share one notification. A block that arrives while no bb window is open is announced by the next window that opens. The sidebar entry shows the number of open questions.

With bb in the background and notifications allowed, you get a system notification. Otherwise you get a bb toast. To allow notifications in a browser, use Settings, Push notifications, Allow notifications.

bb plugins cannot send a mobile push. The push-notifications plugin sends pushes only for thread events, and none of its RPC methods sends other text.

## CLI

```
bb sgc questions [--json] [--cached]
bb sgc answer <issue> --text-file <file> [--machine <name-or-id>] [--json]
bb sgc key --api-key-stdin
```

- `questions` polls Linear and prints each open question with the recommended option first. `--cached` prints the last poll and reads nothing. It exits 1 when Linear could not be read.
- `answer` posts the file as one unsigned comment, as written, so number the answers to match: `Q1. A`. It refuses text that starts with `[agent:` and issues with no open questions. It reads the file on the machine of the thread that runs it. Outside a thread, it reads the file on the `--machine` you name, or else on the bb server's machine.
- `key` reads the API key from stdin and stores it.

## Settings

```
bb plugin config sgc-steward set pollMinutes 10
bb plugin config sgc-steward set notify false
```

- `linearApiKey` (secret): set it with `bb sgc key`. The key needs read and write access to the team.
- `teamKey` (default: the steward's team): the Linear team to watch.
- `pollMinutes` (default 5): how often to read Linear. A change starts a poll at once.
- `notify` (default true): announce new question blocks.

## Develop

```
npm install
npm test
npx tsc -p .
bb plugin build .
bb plugin logs sgc-steward
```

`npm test` runs the TypeScript files directly with `node --test`. Tests use a fake Linear and bb's fake plugin host, so they need no key and no server.

## Layout

- `lib/questions.ts`: the question format, the open rules, and the answer text.
- `lib/linear.ts`: the Linear GraphQL client.
- `lib/panel.ts`: the page's answer drafts and the notification text.
- `server.ts`: settings, the poller, the SQLite record of announced blocks, RPC, and the `bb sgc` CLI.
- `app.tsx`: the SGC questions page, its sidebar badge, and the notifier.
- `skills/sgc-steward/SKILL.md`: the format and the CLI, for agents.
