Answer the questions a steward agent asks on Linear check-in issues, from a page in bb, without blocking the agent's thread.

## What you get

- An **SGC questions** page in the left sidebar. It lists the open question blocks, grouped by issue, with each question's options and the recommended one first.
- Pick an option or type an answer for each question, then post. The plugin posts one unsigned comment per issue, numbered to match, that names each block it answers. On a needs-decision issue it also removes the label when no newer question is open.
- A sidebar badge with the number of open questions, and one notification per new question block: a system notification while bb is in the background, a bb toast otherwise.
- A `bb sgc` command: `questions` lists the open questions, `answer` posts a file as the answer, `key` stores the Linear API key from stdin.

## How it works

A service on the bb server polls Linear every five minutes for the team's issues with the `checkin` or `needs-decision` label. A signed comment starts with `[agent:`. An answer from the plugin closes only the blocks it names. Any other unsigned comment closes every block before it. Before posting, the plugin reads the issue again and refuses if a block changed, a new one arrived, or the issue closed. The API key is a secret setting on the server.

bb plugins cannot send mobile pushes, so the notifications reach only open bb windows.

## For agents

The bundled skill gives the question format the steward writes and the `bb sgc` commands.
