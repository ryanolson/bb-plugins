# bb-plugin-sgc-steward

Agents need decisions from you. A bb question dialog stops the asking thread until you answer, and a question posted on Linear sends you no notification, because every agent posts through your own login. This plugin puts both kinds of question on one page in bb, notifies you once per question, and sends each answer back: to Linear and to the asking thread. No agent waits on a dialog.

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
- An answer from this plugin names each block it answers, as `(block <comment id> rev <revision>)` in a header line. It closes only those blocks, at that revision. Any other answer closes every block before it.
- On a check-in issue (label `checkin`), a signed comment is a question block when it has a `Q1.` line or a bare `Questions` header. Run reports and digests stay out. A block is open until an answer closes it. A reply in a comment thread counts.
- On a needs-decision issue (label `needs-decision`), the latest signed comment is the question, in any shape. It is open while the issue has the label and no answer closed it.
- Completed and canceled issues are skipped.

## Answer format

One comment answers every open block on the issue. The page writes it like this:

```
Answers to the questions of 2026-01-05 (block 4f1c2e9a-5b6d-4c8e-9f0a-1b2c3d4e5f60 rev 3fa2c9d01b7e)

Q1. A: Powers of two: 1, 2, 4, 8.

Q2. B: The cells.
Start with the cells project.

Q3. No answer.
```

A picked option gives its letter and its text, and a note goes on the next line. A typed answer follows the number. When one comment answers several blocks, each block gets its own header, with the time the block was posted. Answering a needs-decision issue also removes the label, unless a newer question is open on the issue. A question posted in the one request between the plugin's last read and the label removal loses the label. This is a known limit.

## bb questions

An agent asks with `bb sgc ask`. The command stores the question and returns its id at once, and the agent keeps working. Questions live in the plugin's SQLite database, so they survive a restart. The page shows them with the Linear questions, oldest first, each with the asking thread as a link, its title, and its issue if it names one.

When you answer, the plugin sends the answer to the asking thread as a queued message, as `bb thread tell --mode queue` does. The message starts with `[sgc-steward] Answer to <id>` and quotes the question and your answer word for word. When the question names an issue, the plugin also posts a comment there that records the question and your answer. The record starts with `Answer to bb question`, so it closes no Linear question block.

When you answer a Linear block, the plugin also sends the answer to the bb thread named in the block's signature.

A send or a record that fails is kept and listed on the page, with a retry. A send that looked failed may still have arrived, so a retry can deliver an answer twice. A send that a restart cut short is listed the same way.

The sends for an answer to a Linear block are kept before the answer posts. When a restart stops the post, a later poll sends them once the answer is on Linear. When the answer is still not on Linear ten minutes after its latest post began, the post failed, and the poll drops them.

## How it works

A service on the bb server polls Linear every `pollMinutes`. It lists the team's open issues that have the `checkin` or `needs-decision` label. It reads an issue's comments again only when the issue changed, and every issue once an hour. It reads every page of an issue's comments, threaded replies included, and sorts them itself. An issue with more than 1000 comments, or more than 20 replies in one thread, shows as unreadable instead of being guessed. Polls and answers run one at a time. Each request to Linear has a 30-second deadline, and an answer stops a poll in progress and skips polls waiting their turn, instead of waiting for them. An answer's comment id comes from the answer itself, so the same answer, retried or sent again, is never posted twice. Each block has a revision, a hash of its context, questions, and options, and the thread in its signature. Before it posts, it reads the issue again. It refuses when the open blocks or their revisions changed, or when the issue is completed or canceled, so an answer never closes a question you did not see.

## Notifications

When a poll finds a new question block, or an agent asks a bb question, every open bb window hears about it. The first window to ask for it gets it, so each question is announced once. Questions that arrive together share one notification. A question that arrives while no bb window is open is announced by the next window that opens. The sidebar entry shows the number of open questions.

With bb in the background and notifications allowed, you get a system notification. Otherwise you get a bb toast. To allow notifications in a browser, use Settings, Push notifications, Allow notifications.

bb plugins cannot send a mobile push. The push-notifications plugin sends pushes only for thread events, and none of its RPC methods sends other text.

## CLI

```
bb sgc ask --question <text> | --question-file <file> [--option <text>]... [--recommend <letter|none>] [--issue <TEAM-12>] [--thread <id>] [--json]
bb sgc withdraw <id> [--thread <id>] [--json]
bb sgc questions [--json] [--cached]
bb sgc answer <issue> --block <id>@<revision> --text-file <file> [--machine <name-or-id>] [--json]
bb sgc key --api-key-stdin
```

- `ask` stores a question from the calling thread, or the `--thread` you name, and prints its id. Options get letters A, B, and so on, and A is recommended unless `--recommend` says otherwise. The same open question from the same thread returns its id again. A thread can have 10 open questions, and all threads 50.
- `withdraw` closes a question. Only the thread that asked it can withdraw it. `--thread` names that thread when you run the command outside a thread.

- `questions` polls Linear and prints each open question, both kinds, with the recommended option first, and each block as `<comment id>@<revision>`. It also lists the answers that did not go out. `--cached` prints the last poll and reads nothing. It exits 1 when Linear is not set up or could not be read, or an issue's comments could not be read.
- `answer` posts one comment: a header line that names each `--block`, then the file's text as written. Number the answers to match: `Q1. A`. Name every open block of the issue, as `questions` prints it. It refuses when the open blocks or their revisions differ, when the text starts with `[agent:`, and when the issue has no open questions. It reads the file on the machine of the thread that runs it. Outside a thread, it reads the file on the `--machine` you name, or else on the bb server's machine.
- `key` reads the API key from stdin and stores it.

## Settings

```
bb plugin config sgc-steward set pollMinutes 10
bb plugin config sgc-steward set notify false
```

- `linearApiKey` (secret): set it with `bb sgc key`. The key needs read and write access to the team. A key with spaces, line breaks, or other control characters is refused, and error messages never show the key.
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
- `lib/asks.ts`: checks for `bb sgc ask` and the text of what goes back: the message to the thread and the Linear record.
- `lib/ask-store.ts`: the SQLite tables for bb questions, deliveries, and records.
- `lib/linear.ts`: the Linear GraphQL client, and posting a comment under the id its answer derives.
- `lib/panel.ts`: the page's answer drafts, card order, badge, and notification text.
- `lib/contract.ts`: the RPC contract between the server and the page, and the shapes the page shows.
- `lib/format.ts`: plain text for questions: notification previews, the `bb sgc questions` listing, and its `--block` option.
- `server.ts`: settings, the poller, the answer and delivery paths, RPC, and the `bb sgc` CLI.
- `app.tsx`: the SGC questions page, its sidebar badge, and the notifier.
- `skills/sgc-steward/SKILL.md`: the format and the CLI, for agents.
