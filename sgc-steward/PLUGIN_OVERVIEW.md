Answer the questions your agents ask, on Linear check-in issues or with `bb sgc ask`, from one page in bb, without blocking any thread.

## What you get

- An **SGC questions** page in the left sidebar. It lists the open questions, oldest first: Linear question blocks grouped by issue, and bb questions with the asking thread as a link. Options show the recommended one first.
- `bb sgc ask` for agents: it stores the question and returns at once, so the agent keeps working. Your answer goes back to the asking thread as a queued message that quotes the question and your answer. A question that names an issue also gets a record of the answer on it. The steward thread can withdraw a question that is no longer valid, and the asking thread is told why.
- Pick an option or type an answer for each question, then post. The plugin posts one unsigned comment per issue, numbered to match, that names each block it answers. On a needs-decision issue it also removes the label when no newer question is open.
- A sidebar badge with the number of open questions, and one notification per new question block: a system notification while bb is in the background, a bb toast otherwise.
- A `bb sgc` command: `ask` and `withdraw` for agents, `questions` lists the open questions, `answer` posts a file as the answer to Linear blocks, `key` stores the Linear API key from stdin.

## How it works

A service on the bb server polls Linear every five minutes for the team's issues with the `checkin` or `needs-decision` label. A signed comment starts with `[agent:`. An answer from the plugin closes only the blocks it names. Any other unsigned comment closes every block before it. Before posting, the plugin reads the issue again and refuses if a block changed, a new one arrived, or the issue closed. An answer to a Linear block also goes to the bb thread named in the block's signature. The plugin keeps that send before it posts the answer, so a restart in the middle cannot lose it. bb questions live in the plugin's SQLite database, so they survive a restart. The API key is a secret setting on the server.

## Known limits

- bb plugins cannot send mobile pushes, so the notifications reach only open bb windows.
- After an answer on a needs-decision issue, the plugin reads the issue once more and then removes the label. A new question posted between that read and the removal loses the label, though it is still open. The window is one request.
- An issue with more than 1000 comments, or more than 20 replies in one thread, shows as unreadable, with its name in the message.
- An answer that could not be sent to its thread, or whose send a restart cut short, is kept, with a retry. The plugin never retries on its own, because a send that looked failed may have arrived, and a retry can deliver it twice.
- Only a signature with a bb thread id, like `thr_abc123`, gets the answer sent to a thread.

## For agents

The bundled skill gives the question format the steward writes and the `bb sgc` commands.
