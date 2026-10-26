---
name: sgc-steward
description: Ask the owner questions on Linear check-in issues in the format the SGC Steward page reads, or list open questions and relay an answer with `bb sgc`. Use when you are the steward agent writing check-in questions, when you park a question with the needs-decision label, or when the user asks about open steward questions.
---

# SGC Steward questions

The SGC Steward plugin shows your questions to the owner on a page in bb and posts the answers back to Linear. Do not ask in a bb question dialog: it blocks your thread. Post the questions on Linear and keep working.

## Asking

Post each set of questions as one signed comment on the check-in issue:

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

A comment that breaks a rule is still shown, but as plain text without option buttons.

On a needs-decision issue, the latest signed comment is the question. Use the same format there when the question has options.

## Reading the answer

- The owner's answer is the first unsigned comment after your block. It closes every open block on the issue.
- The page writes `Q1. A: <option text>` for a picked option, `Q2. <text>` for a typed answer, and `Q3. No answer.` for a skipped question. A note can follow on the next line.
- Ask again in a new block for every question marked `No answer.` that still matters.

## Commands

```
bb sgc questions [--json] [--cached]
bb sgc answer <issue> --text-file <file> [--machine <name-or-id>] [--json]
```

- `bb sgc questions` lists the open questions with the recommended option first.
- `bb sgc answer` posts the file as one unsigned comment. Linear then treats it as the owner's answer. Use it only to relay the owner's own words, never your own judgment.
- Number the relayed answers to match: `Q1. A`, `Q2. <text>`.
- The command refuses text that starts with `[agent:`, and issues with no open questions.
