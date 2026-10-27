Answer the questions your agents ask, on Linear check-in issues or with `bb sgc ask`, from one page in bb, without blocking any thread.

## What you get

- An **SGC questions** page in the left sidebar, with two tabs, Questions and Todos, each showing how many are open. The Questions tab lists the open questions, oldest first, each on its own card: every question of a Linear block, with its issue, and bb questions with the asking thread as a link. Options show the recommended one first.
- `bb sgc ask` for agents: it stores the question and returns at once, so the agent keeps working. Your answer goes back to the asking thread as a queued message that quotes the question and your answer. A question that names an issue also gets a record of the answer on it. The steward thread can withdraw a question that is no longer valid, with the `sgc_withdraw_question` agent tool, and the asking thread is told why.
- Pick an option or type an answer on a question's card, then post it. The plugin posts one unsigned comment per answer, numbered to match, that names the block, and the question when the block holds several. A block stays open until each of its questions has an answer. On a needs-decision issue the plugin then removes the label, when no newer question is open.
- A Todos tab: your open Linear todos with their steps, a Done button with a note, and Undo for a Done from the page. Done comments as you, moves a `human` issue to Done or removes the waiting label from any other, and tells the steward thread.
- A sidebar badge with the number of open questions, and one notification per new question block or todo, which opens its tab: a system notification while bb is in the background, a bb toast otherwise.
- A `bb sgc` command: `ask` and `withdraw` for agents, `questions` lists the open questions, `answer` posts a file as the answer to Linear blocks, `todos` and `todo done` list your todos and mark one done, `key` stores the Linear API key from stdin.

## How it works

A service on the bb server polls Linear every five minutes for the team's issues with the `checkin` or `needs-decision` label, and for your todos. A signed comment starts with `[agent:`. An answer from the plugin closes only the blocks, or the questions of a block, it names. Any other unsigned comment closes every block before it. Before posting, the plugin reads the issue again and refuses if the block changed, the question has an answer already, or the issue closed. An answer to a Linear block also goes to the bb thread named in the block's signature. The plugin keeps that send before it posts the answer, so a restart in the middle cannot lose it. bb questions live in the plugin's SQLite database, so they survive a restart. The API key is a secret setting on the server.

A todo's Done or Undo is kept in the same database before it writes to Linear. Its comment goes under its own id, so it never posts twice. When its change fails, the todo stays on the list, and pressing Done again finishes the same Done, with its own comment and note. When the change landed but its reply was lost, or the plugin restarted, the plugin reads the issue again, or the next poll does, and finishes it. The poll only reads Linear; it never writes to finish a Done. Four rules keep the steward's messages right through any failure or restart:

- Each Done or Undo is one row that holds its message, and the steward thread it goes to, from the start. A retry changes neither.
- Finishing that row and keeping its message to send are one transaction, so the steward hears once, after Linear holds the change. Giving up an action is one delete, before any message exists.
- Every Undo, a retry included, first checks that its Done is the latest on the issue, and that the issue is as that Done left it. Otherwise it writes nothing.
- Messages go out one at a time, in the order their actions finished. On one issue, an action finishes or is given up before the next one begins, so its messages first go out in the order you took them.

## Known limits

- bb plugins cannot send mobile pushes, so the notifications reach only open bb windows.
- After an answer on a needs-decision issue, the plugin reads the issue once more and then removes the label. A new question posted between that read and the removal loses the label, though it is still open. The window is one request.
- An issue with more than 1000 comments, or more than 20 replies in one thread, shows as unreadable, with its name in the message.
- An answer that could not be sent to its thread, or whose send a restart cut short, is kept, with a retry, and an X that dismisses it for good. The plugin never retries on its own, because a send that looked failed may have arrived, and a retry can deliver it twice.
- Only a signature with a bb thread id, like `thr_abc123`, gets the answer sent to a thread.
- Undo works only for a Done from the page in this plugin load, for an hour, and only for the latest Done of its issue. After a reload or an update, reopen the issue in Linear.
- The plugin knows only its own Dones. If someone reopens an issue in Linear and completes it there again, with the same state and labels, Undo of the plugin's earlier Done still passes its checks and puts back the state from before that Done.
- A todo message that failed to send, or whose send a restart cut short, waits for your retry on the page. So the steward can get it after a later message about the same issue. When two messages about one issue disagree, the issue in Linear decides.
- An Undo posts its `Reopened (from the SGC page)` comment before it changes the issue. When it cannot finish, because the issue changed since the Done or no page can retry it any more, the plugin gives it up, and the comment stays without the change.
- The first poll after the update announces every todo open then, in one notification.
- The plugin cannot tell a Done by you from one an agent ran with `bb sgc todo done`: the CLI does not verify its caller. The skill tells agents to run it only to relay your own word that the action is done.
- Any agent can change plugin settings: every agent runs as you, with full access, and bb has no setting that only you can change. So an agent can name itself in `stewardThread`, then withdraw the questions of other threads and get the messages about your todos. Only you change plugin settings. The steward checks on each run that `stewardThread` names itself, and flags any change in its digest.
- The `bb sgc` CLI takes the calling thread from `BB_THREAD_ID`, which the bb CLI forwards without checking. So `withdraw` and `ask --thread` trust it, and a process that sets it can withdraw another thread's question or ask for another thread. Withdrawing any thread's question is therefore not in the CLI. It is only in the `sgc_withdraw_question` agent tool. The bb plugin SDK hands that tool, for each call, the thread of the agent session that made the call, and no argument or environment variable sets it.

## For agents

The bundled skill gives the question format the steward writes and the `bb sgc` commands.
