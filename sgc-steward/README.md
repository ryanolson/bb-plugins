# bb-plugin-sgc-steward

Agents need decisions from you. A bb question dialog stops the asking thread until you answer, and a question posted on Linear sends you no notification, because every agent posts through your own login. This plugin puts both kinds of question on one page in bb, notifies you once per question, and sends each answer back: to Linear and to the asking thread. No agent waits on a dialog. The same page lists your todos: the Linear issues that wait on something only you can do.

## Install

```
bb plugin install git:https://github.com/ryanolson/bb-plugins.git --subdirectory sgc-steward
<command that prints your Linear API key> | bb sgc key --api-key-stdin
bb plugin reload sgc-steward
```

The key goes to the plugin's secret settings on the bb server and is never printed. You can also paste it in Settings, Installed plugins, SGC Steward. Until the key is set, the plugin reads nothing and the page says how to set it.

The next poll uses the key without a reload. But a plugin that loaded without a key stays marked as needing configuration in `bb plugin list` until it loads again, because saving a setting does not reload it. The reload clears that mark.

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
- A question with no options takes a typed answer. Its card offers "Answer in the note below" and then Pause, and the note is the answer: Send waits for it. An ask stored before the note existed holds Pause alone, so its card puts the note first on the next free letter and leaves Pause its own, and an answer already given keeps its meaning.
- The card adds Pause on the next free letter, so a question with 25 options gets Z for it; with all 26 letters in use, the card shows the asker's options and adds nothing, rather than letter a choice `[`.
- Any other line continues the question above it. An indented line continues the option above it.

The page shows a comment that breaks these rules as written, with the reason, and takes an answer for it: the note choice, or Pause, with or without a note.

## Markdown in questions

The page shows a question's text, its context, and each option as Markdown, with bb's own renderer, the one chat messages use. Headings, bold, links, lists, tables, inline code, and code blocks all render. This holds for bb questions and for Linear blocks.

Agents write these questions, so the page never runs HTML from them. bb's renderer passes raw HTML through a sanitizer that drops scripts, event handlers, `javascript:` links, frames, and styles. A few harmless tags still show, such as `<details>` and an image from an `https` address. The plugin has no HTML path of its own.

- A table needs a header row, then a delimiter row such as `| --- | --- |`, then its rows. Without the delimiter row, the lines show as plain text, `|` characters and all. A blank line before the table reads better, but a table also renders right under a line of text. `bb sgc ask` warns about a table it finds with no delimiter row (see CLI).
- A bb question keeps every line as written. Use `--question-file` for a long one, so the shell cannot change its lines or its backticks.
- A Linear block drops blank lines and indentation inside a question. A table, a flat list, and a code block still render, but nested lists and code lose their indentation, and a code block loses its blank lines. Put text with that kind of structure in a bb question.

## When a question is open

- A signed comment starts with `[agent:`. Any other comment from a user is your answer. Comments from integrations are neither.
- An answer from this plugin names what it answers in a header line: `(block <comment id> rev <revision>)` for a whole block, or `(block <comment id> rev <revision>), Q2` for one question of it. It closes only those, at that revision, and a block closes once each of its questions has an answer. Any other answer closes every block before it.
- A comment whose first line is `Done (from the SGC page)` or `Reopened (from the SGC page)` marks a todo. It is yours, but it answers no question, so it closes no block.
- On a check-in issue (label `checkin`), a signed comment is a question block when it has a `Q1.` line or a bare `Questions` header. Run reports and digests stay out. A block is open until an answer closes it. A reply in a comment thread counts.
- On a needs-decision issue (label `needs-decision`), the latest signed comment is the question, in any shape. It is open while the issue has the label and no answer closed it.
- Completed and canceled issues are skipped.

## Answer format

Each question is a card on the page, and each answer is one comment. An answer to a block's only question, or to every question of a block, names the block:

```
Answers to the questions of 2026-01-05 (block 4f1c2e9a-5b6d-4c8e-9f0a-1b2c3d4e5f60 rev 3fa2c9d01b7e)

Q1. A: Powers of two: 1, 2, 4, 8.
```

An answer to one question of a block that holds several names the question after the block. The block stays open until each of its questions has an answer:

```
Answer to the questions of 2026-01-05 (block 4f1c2e9a-5b6d-4c8e-9f0a-1b2c3d4e5f60 rev 3fa2c9d01b7e), Q2

Q2. B: The cells.
> Start with the cells project.
```

A picked option gives its letter and its text on the number's line. A typed answer leaves the number alone on its line. Everything you write, a note or a typed answer, follows below the number as a quote: every line starts with `> `, and an empty line is `>`, so your text shows as a quote in Linear with every word kept. Only the headers the plugin writes name what an answer answers: no line of yours stands outside the quote, so nothing you write, in a code block or not, can read as a header, even after an edit in Linear. The question number follows the block reference, not inside it, so a reader that knows only whole-block answers takes it for an answer to that one block, not to every block before it. When one comment answers several blocks, as `bb sgc answer` can, each block gets its own header, with the time the block was posted. Answering the last open question of a needs-decision issue also removes the label, unless a newer question is open on the issue. A question posted in the one request between the plugin's last read and the label removal loses the label. This is a known limit.

## bb questions

An agent asks with `bb sgc ask`. The command stores the question and returns its id at once, and the agent keeps working. Questions live in the plugin's SQLite database, so they survive a restart. The page shows them with the Linear questions, oldest first, each with the asking thread as a link, its title, and its issue if it names one.

When you answer, the plugin sends the answer to the asking thread as a queued message, as `bb thread tell --mode queue` does. The message starts with `[sgc-steward] Answer to <id>` and quotes the question and your answer word for word. When the question names an issue, the plugin also posts a comment there that records the question and your answer. The record starts with `Answer to bb question`, so it closes no Linear question block.

When you answer a Linear block, the plugin also sends the answer to the bb thread named in the block's signature.

`bb sgc answer-of <id>` reports how a bb question was answered from the plugin's own record, never from Linear, so a Linear comment that copies an answer changes nothing. Its `channel` says where the answer came from: `bb` is the plugin's answer RPC, which the page calls. A known limit: bb hands every RPC, from the page, the `bb` CLI, or an agent, to the plugin as the same caller, so an agent can answer a bb question with `bb plugin rpc call sgc-steward asks.answer`, and its answer also shows `channel` `bb`. An agent can also write the plugin's database, which belongs to the user every agent runs as. So `answer-of` proves which path stored the answer, not that you gave it. An answer stored before `channel` was kept shows `null`.

A question can go stale: its issue closes, a later question replaces it, or events decide it. The steward thread, named in the `stewardThread` setting, withdraws a stale question with the `sgc_withdraw_question` agent tool, giving the question id and the reason. The plugin then sends the asking thread a queued message that starts with `[sgc-steward] Withdrawn <id>` and gives the reason, so the thread stops waiting. It skips the message when bb reports the asking thread archived, deleted, or missing. When the thread cannot be looked up, it keeps the message, to be sent or retried. When the question names an issue, the plugin also posts a record of the withdrawal there. That record also starts with `Answer to bb question`, so it closes no Linear question block. The page no longer shows a withdrawn question.

A send or a record that fails is kept and listed on the page, with a retry. A send that looked failed may still have arrived, so a retry can deliver an answer twice. A send that a restart cut short is listed the same way. Each one also has an X that dismisses it: it leaves the page and is never sent or posted. Use it when a retry cannot succeed, for example when the thread is archived.

The sends for an answer to a Linear block are kept before the answer posts. When a restart stops the post, a later poll sends them once the answer is on Linear. When the answer is still not on Linear ten minutes after its latest post began, the post failed, and the poll drops them.

## Expiry

A bb question that nobody answers expires after 3 days, or 1 day when asked with `--urgent`. Each poll, and so every `pollMinutes`, expires the open questions whose time is up, whether or not a Linear key is set. An expired question leaves the Questions list and takes no answer: the answer RPC refuses it with code `conflict`. Only an open question expires, in one transaction with its notice, so an answer, a withdrawal, and an expiry that race have one winner, and the others save nothing.

The asking thread gets a queued message that starts with `[sgc-steward] Expired <id>`. It says no answer came by the deadline and tells the thread to save its work (commit, push, and check that the remote branch matches HEAD), comment `paused: no answer by <date>` on the issue with the branch and commit, release its claim, move the issue to Backlog with the `paused` label, and archive itself after the save, unless it is the steward thread. A thread that bb reports gone is not told. When the question names an issue, the plugin also posts a record comment there. The notice and the record are kept before they send, once each, and a failed send or post is listed with a retry, as for a withdrawal.

A question stored before expiry existed has no clock. Its first poll after the upgrade gives it 3 days from then, so it does not expire at once. `bb sgc questions --json` lists the questions that expired in the last 14 days in `expired`, newest first.

## Todos

Your todos are on the page's Todos tab. An issue is on your todo list when it is open and has the `waiting:ryan-action` label, or when it has the `human` label and is assigned to you, the user of the API key. An issue that waits on your decision, with `waiting:ryan-decision`, becomes a question instead. Each todo shows its link and the task lines of its description, the `- [ ]` lines, so you see the steps. `bb sgc todos` lists them too.

Done posts one comment from you on the issue: `Done (from the SGC page)`, and your note if you wrote one. Then a `human` issue moves to the team's Done state. Any other issue loses the `waiting:ryan-action` label and keeps its state, so the agent work behind it goes on. The steward thread, named in `stewardThread`, gets a queued message that starts with `[sgc-steward] Todo done <issue>: <title>`, with your note on the next line. With no steward thread set, or one that is archived or gone, nothing is sent, and the change on Linear still counts. A message that fails to send is listed on the Todos tab with a retry.

Two Done clicks at once act once: the plugin reads the issue again under its lock and refuses a todo that is no longer on the list. A Done is kept before it writes, with the steward's message and the steward thread it goes to, and its comment goes under its own id. When Linear does not take the change, the todo stays on the list, and pressing Done again finishes that same Done, with its own comment, note, and steward thread; a new note is not used. When the change landed but the reply was lost, or the plugin restarted, the plugin, or the next poll, reads the issue and finishes the Done. The steward hears once, after Linear holds the change. Its messages go out in the order you acted, but one that failed to send waits for your retry on the page, so it can arrive after a later one. A Done from the page can be undone from the same page, for an hour, until the plugin reloads, and only while it is the latest Done of its issue: a newer Done of the issue, from the page or the CLI, replaces it. Undo posts `Reopened (from the SGC page)`, puts the label or the state back, and sends the steward `[sgc-steward] Todo reopened <issue>: <title>`. Undo refuses an issue that is no longer in the team, or that changed after the Done, with another state or other labels, so a later change, such as a cancellation, stays. This holds when you press Undo again after a failed Undo, too: an Undo whose change Linear already holds finishes without writing again, and any other is given up, which leaves its `Reopened` comment on the issue.

## Paused

The Paused tab lists work that stopped. It holds two kinds of row, with a count on the tab: the team's open issues with the `paused` label, newest change first, and the bb questions that expired in the last 14 days (see "Expiry"). Each poll reads the paused issues, with one more request, and a failed read keeps the list from the read before and shows its error on the tab without stopping the questions.

Resume, on a paused issue, posts one comment from you, `Resumed (from the SGC page)` and your note, removes the `paused` label, moves the issue to the team's Todo state (its unstarted state named Todo, else its first unstarted state), and sends the steward thread a queued message that starts with `[sgc-steward] Resumed <issue>: <title>`. It works as Done does: the Resume is kept before it writes, its comment goes under its own id, and the message is kept in the transaction that finishes it. A repeat after a failed state change, or after a lost reply, finishes that same Resume, with its own comment, note, and steward thread, and posts no second comment. A repeat of a Resume that already finished is refused, because the issue is no longer paused. An expired question that names an issue gets the same Resume box; one with no issue gets only Dismiss, which hides the row in this browser (it keeps nothing on Linear or in the plugin).

Every Linear link the page draws, on Questions, Todos, and Paused, is a `linear://` link, so it opens the Linear app. The CLI keeps `https://` links. The helper is `appLink` in `lib/links.ts`.

## Hosts

The page's Hosts tab and `bb sgc hosts` show, for each host: its name and id, connected or disconnected, the threads running a turn, the threads open but idle, the turns waiting on bb's concurrency limit with the oldest wait, and the limit, with `override` or `automatic`. Both show the same view model, and `--json` prints it. The plugin only reads: it never changes a limit. Set one with `bb concurrency-limit host`.

- Running threads are `starting` or `active`, as bb counts them against the limit. Idle threads have the status `idle`.
- A waiting turn is a thread with a queued row that the `concurrency-limit` plugin holds. Its wait counts from when its oldest held row was queued. A row that first waited behind its own thread's turn counts from then, so the wait can read longer than the hold.
- When another plugin's wait comes first on a row, bb names only that plugin, and the row does not count.
- A thread on no host that bb lists, such as a new thread before its workspace, shows on a `(no host)` row.
- The limits come from the concurrency-limit plugin's `getConfiguration` RPC, the same read that `bb concurrency-limit status --json` prints. It is the only RPC the plugin calls. When it fails, the counts still show without limits, and `bb sgc hosts` exits 1.
- The tab reads bb when the page opens, and every 30 seconds while the tab is open. Its count is the waiting turns, and its dot means the limits could not be read.
- `bb sgc hosts --digest` prints only the flags for the steward: the global limit when it is reached, the hosts at their limit, and the hosts with waiting turns and the oldest wait.

## How it works

A service on the bb server polls Linear every `pollMinutes`. It lists the team's open issues that have the `checkin` or `needs-decision` label. It reads an issue's comments again only when the issue changed, and every issue once an hour. It reads every page of an issue's comments, threaded replies included, and sorts them itself. An issue with more than 1000 comments, or more than 20 replies in one thread, shows as unreadable instead of being guessed. Polls and answers run one at a time. Each request to Linear has a 30-second deadline, and an answer stops a poll in progress and skips polls waiting their turn, instead of waiting for them. An answer's comment id comes from the answer itself, so the same answer, retried or sent again, is never posted twice. Each block has a revision, a hash of its context, questions, and options, and the thread in its signature. Before it posts, it reads the issue again. It refuses when the block it answers changed or closed, when a question it answers has an answer already, or when the issue is completed or canceled, so an answer never closes a question you did not see. A block that arrived since does not stop it, because the answer does not name that block. Each poll also reads the todo list, in one more request. A failed read of the todos keeps the list from the read before and does not stop the questions.

## Notifications

When a poll finds a new question block or a new todo, or an agent asks a bb question, every open bb window hears about it. The first window to ask for it gets it, so each question and todo is announced once. Questions that arrive together share one notification. A question that arrives while no bb window is open is announced by the next window that opens. The sidebar entry shows the number of open questions. On the page, each tab shows how many are open on it, and a dot when something there failed: a send, a record, or a read. A notification of new todos only opens the Todos tab; any other opens Questions.

With bb in the background and notifications allowed, you get a system notification. Otherwise you get a bb toast. To allow notifications in a browser, use Settings, Push notifications, Allow notifications.

bb plugins cannot send a mobile push. The push-notifications plugin sends pushes only for thread events, and none of its RPC methods sends other text.

## CLI

```
bb sgc ask --question <text> | --question-file <file> --option <text> [--option <text>]... [--recommend <letter|none>] [--issue <TEAM-12>] [--urgent] --label <project name> [--thread <id>] [--json]
bb sgc withdraw <id> [--reason <text>] [--thread <id>] [--json]
bb sgc questions [--json] [--cached] [--label <name>]... [--match any|all]
bb sgc answer-of <id> [--json]
bb sgc answer <issue> --block <id>@<revision> --text-file <file> [--machine <name-or-id>] [--json]
bb sgc todos [--json] [--cached]
bb sgc paused [--json] [--cached]
bb sgc resume <issue> [--note <text>] [--json]
bb sgc todo done <issue> [--note <text>] [--json]
bb sgc hosts [--digest] [--json]
bb sgc key --api-key-stdin
```

- `ask` stores a question from the calling thread, or the `--thread` you name, and prints its id. Options get letters A, B, and so on, and A is recommended unless `--recommend` says otherwise. A question is at most 80 words (and 4000 characters), with 1 to 3 options of at most 25 words each; `ask` refuses any other number with code `invalid`. Every question also gets a last option, "Pause it: stop this work for now, and resume it later.", which is never recommended and counts against no limit. `--label` is required, exactly once, at most 80 characters: the name of one of the team's Linear projects that is not completed or canceled, in any case. Each poll reads the project names and the plugin keeps the last good list in memory; a failed read keeps the old list. With no list yet, because Linear is not set up or no poll has finished, any label is taken and `ask` prints a `Warning:` line (`warnings` with `--json`). Stored questions from before these limits keep their data and are not checked again. An unanswered question expires 3 days after it was asked, or 1 day with `--urgent`; see "Expiry". The same open question from the same thread returns its id again, and keeps the label it was first asked with. A thread can have 10 open questions, and all threads 50.
- `ask` also warns, in one more line that starts with `Warning:` (with `--json`, in a `warnings` list), when the question or an option holds a table the page will show as plain text. It parses the text as the page does (GFM and math blocks) and looks for two or more lines in one paragraph that start and end with `|`. A table the page draws, and pipes inside code, HTML or math, never count. The usual cause is a missing delimiter row, or one with the wrong number of cells. It still stores the question as written. Withdraw it and ask again to fix the table.
- `withdraw` closes a question that the calling thread asked. `--thread` names that thread when you run the command outside a thread. `--reason` is stored with the question. The CLI cannot withdraw another thread's question, not even for the steward, which uses its agent tool instead.

- `questions` polls Linear and prints each open question, both kinds, with the recommended option first, and each block as `<comment id>@<revision>`. It also lists the answers that did not go out. `--cached` prints the last poll and reads nothing. `--label` lists only the questions that have that label, in any case. Give it again for more: a question then needs any one of them, or, with `--match all`, every one; any is the default, as Linear's label filter starts. A Linear question carries its issue's labels, a label in a label group as `group/name`, such as `area/gdl`, so one filter covers both kinds. `--json` shows the labels of each issue and each bb question. It exits 1 when Linear is not set up or could not be read, or an issue's comments could not be read.
- `answer-of` prints a bb question as the plugin stored it: the asking thread, its issue, the question and options as asked, its status (`open`, `answered`, or `withdrawn`), and, once answered, the time in RFC 3339, the `channel`, the picked `option` as its letter and text or `null` for a typed answer, and the typed `text` or note. It reads nothing from Linear. The picked choice is the one the card showed, so it may be the Pause every card adds, or the note a question with no options offers; the note comes back as a typed answer, with no `option`. It exits 0 for a known id, and 1 for an unknown one, or for a stored answer that names a choice the card never showed, which only an edit outside the plugin makes.
- `answer` posts one comment: a header line that names each `--block`, then the file's text, quoted line by line. Number the answers to match: `Q1. A`. Name each block the text answers, as `questions` prints it; it answers each one whole. It refuses when a named block changed or closed, when the text starts with `[agent:`, and when the issue has no open questions. It reads the file on the machine of the thread that runs it. Outside a thread, it reads the file on the `--machine` you name, or else on the bb server's machine.
- `todos` polls Linear and prints your todos, each with its link and its task lines. `--cached` prints the last poll and reads nothing. It exits 1 when Linear is not set up or the todos could not be read.
- `paused` lists the paused issues and the questions that expired in the last 14 days, as the Paused tab does. `--json` prints `paused`, `pausedError`, and `expired`. It exits 1 when Linear is not set up or the paused issues could not be read.
- `resume` resumes a paused issue, as the Resume button does. `--note` adds a note to the comment and to the steward's message.
- `todo done` marks a todo done, as the Done button does. `--note` adds a note to the comment and to the steward's message.
- `hosts` prints each host's threads against bb's concurrency limit, as described in [Hosts](#hosts). `--digest` prints only the hosts at their limit and the hosts with waiting turns. It exits 1 when the limits could not be read.
- `key` reads the API key from stdin and stores it.

## Settings

```
bb plugin config sgc-steward set pollMinutes 10
bb plugin config sgc-steward set notify false
bb plugin config sgc-steward set stewardThread thr_abc123
```

- `linearApiKey` (secret): set it with `bb sgc key`. The key needs read and write access to the team. A key with spaces, line breaks, or other control characters is refused, and error messages never show the key.
- `teamKey` (default: the steward's team): the Linear team to watch.
- `pollMinutes` (default 5): how often to read Linear. A change starts a poll at once.
- `notify` (default true): announce new question blocks.
- `stewardThread` (no default): the bb thread id of the steward. Only that thread can withdraw the questions of other threads, with the `sgc_withdraw_question` agent tool, and it gets a message when you mark a todo done or reopen one. The tool reaches a thread when its agent session next starts. `bb plugin config sgc-steward unset stewardThread` turns both off. A known limit: any agent can change this setting, because every agent runs as you and bb has no setting that only you can change, so an agent can name itself the steward and then get your todo messages too. Only you change plugin settings. The steward checks on each run that `stewardThread` names itself, and flags any change in its digest.

## Coding gotchas

- **A state change that two paths can make must be one conditional write.** An answer, a withdrawal, and an expiry each move an open question on. Each does `UPDATE ... WHERE state = 'open'` inside the transaction that keeps its notice, and checks `changes`; a read of the state first is not enough. The loser saves nothing. The first expiry design read the question, awaited a thread lookup, and then wrote; the write still must not trust that read. Tests: `an answer that lands first wins, and an expired question takes no answer or withdrawal` in `lib/expiry.test.ts`.
- **Page code must never import a module that reaches a `node:` builtin.** The page is bundled for the browser. `app.tsx` once imported `appLink` from `lib/paused.ts`, which reaches `lib/questions.ts` and `node:crypto`; every server test passed, and `bb plugin update` failed at the page build. Keep what the page needs in browser-safe modules such as `lib/links.ts`, and use `import type` for types. Test: `lib/page-imports.test.ts` walks the page's import graph.
- **Test time with the injected clock, never with a sleep.** `createAskStore(db, now)` and `setup({ now })` take the clock; expiry tests move it by whole days and poll.

## Develop

```
npm install
npm test
npx tsc -p .
bb plugin build .
bb plugin logs sgc-steward
```

`npm test` runs the TypeScript files directly with `node --test`. Tests use a fake Linear and bb's fake plugin host, so they need no key and no server. Node cannot read JSX, so a test that renders a page component first imports `test-support-tsx.ts`, which transpiles `.tsx` files with TypeScript and stands in for bb's `Markdown`.

## Layout

- `lib/questions.ts`: the question format, the open rules, and the answer text.
- `lib/asks.ts`: checks for `bb sgc ask` and the text of what goes back: the message to the thread and the Linear record.
- `lib/ask-store.ts`: the SQLite tables for bb questions, deliveries, and records.
- `lib/linear.ts`: the Linear GraphQL client, and posting a comment under the id its answer derives.
- `lib/choices.ts`: the choices a question card offers: the asker's options, then Pause, and for a question with none, the note to answer in. The page and the server both use it, so a letter names the same text on both.
- `lib/panel.ts`: the page's tabs, answer drafts, card order, badges, and notification text.
- `lib/contract.ts`: the RPC contract between the server and the page, and the shapes the page shows.
- `lib/views.ts`: the stored rows mapped to the shapes the page and `bb sgc questions --json` show.
- `lib/answer-of.ts`: `bb sgc answer-of`, how a bb question was answered, from the stored row only.
- `lib/format.ts`: plain text for questions: notification previews, the `bb sgc questions` listing, and its `--block` option.
- `lib/host-file.ts`: reading a file named on the command line, on the machine the command came from.
- `lib/settings.ts`: the plugin's settings.
- `lib/links.ts`: the `linear://` link helper, which the page imports.
- `lib/paused.ts`: the Resume comment and message, and the text of `bb sgc paused`.
- `lib/resume-store.ts`: where an unfinished Resume is kept.
- `lib/todos.ts`: which issues are todos, their task lines, and the text that Done and Undo post and send.
- `lib/hosts.ts`: the Hosts view model, its digest, and their text, for the CLI and the page.
- `lib/hosts-read.ts`: the reads of bb behind the Hosts view: the threads, the held rows, and the limits.
- `lib/refusal.ts`: the refusal the page and the CLI both show.
- `paused.ts`: the paused list on the server: its poll, Resume, RPC, and CLI.
- `todos.ts`: the todo list on the server: its poll, Done, Undo, notifications, RPC, and CLI.
- `server.ts`: settings, the poller, the answer and delivery paths, RPC, and the `bb sgc` CLI.
- `app.tsx`: the SGC questions page with its Questions, Todos, and Hosts tabs, its sidebar badge, and the notifier.
- `components/answer-fields.tsx`: a question card's choices, rendered as Markdown radios, and its answer box.
- `test-support-tsx.ts`: lets `node --test` import `.tsx` components, with a stand-in for bb's `Markdown`.
- `skills/sgc-steward/SKILL.md`: the format and the CLI, for agents.
