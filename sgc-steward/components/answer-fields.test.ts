// Question text and options reach bb's Markdown renderer whole: a table, a
// list, inline code and a code block survive the trip from `bb sgc ask` or a
// Linear comment to the page. bb's `Markdown` (react-markdown with remark-gfm,
// raw HTML through rehype-sanitize) draws them and drops any HTML that could
// run; the plugin adds no HTML path of its own.
import "../test-support-tsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installMarkdownRuntime } from "../test-support-tsx.ts";
import { askOptions, checkQuestion } from "../lib/asks.ts";
import { parseQuestionBlock } from "../lib/questions.ts";

const { AnswerFields } = await import("./answer-fields.tsx");

/** A question with each kind of Markdown an agent reaches for. */
const QUESTION = [
  "Should velo run its own tasks on a runtime of its own?",
  "",
  "**Cost**, medians, default vs C:",
  "",
  "| Load | Default | C |",
  "| --- | --- | --- |",
  "| Unary, 1 caller, p50 | 15.7 us | 55.7 us |",
  "| Flood | 441k rec/s | -13% |",
  "",
  "Caveats:",
  "- one aarch64 host over loopback",
  "- `velo::rt` threads pinned apart",
  "",
  "```rust",
  "let rt = velo::Runtime::builder().threads(2).build()?;",
  "```",
  "",
  "See [the results](https://linear.app/example).",
].join("\n");

const OPTIONS = [
  "Ship option C behind `Builder::own_runtime(true)`.",
  "Keep the default, and document the **stall**:\n\n| Case | Stalls |\n| --- | --- |\n| 1 | yes |",
  "Measure more first:\n- a second host\n- real NICs",
];

function render(options: ReturnType<typeof askOptions>) {
  const calls = installMarkdownRuntime();
  const html = renderToStaticMarkup(
    createElement(AnswerFields, { name: "q", label: "Answer", options, draft: { option: null, text: "" }, onChange: () => {} }),
  );
  return { calls, html };
}

test("each option's text reaches Markdown whole", () => {
  const options = askOptions(OPTIONS, "A");
  const { calls, html } = render(options);
  assert.deepEqual(
    calls.map((call) => call.content),
    options.map((option) => option.text),
  );
  // No option text is shown as plain text beside the Markdown.
  assert.doesNotMatch(html, /whitespace-pre-wrap/);
  for (const option of options) assert.match(html, new RegExp(`<span class="font-mono">${option.letter}</span>`));
  assert.match(html, /Recommended/);
});

test("a bb question keeps its Markdown on the way in", () => {
  // `bb sgc ask` stores the question trimmed and nothing else, so the page
  // hands Markdown the exact text the agent wrote.
  assert.equal(checkQuestion(`\n${QUESTION}\n\n`), QUESTION);
  const options = askOptions(OPTIONS, "B");
  assert.deepEqual(
    options.map((option) => [option.letter, option.text, option.recommended]),
    [["A", OPTIONS[0], false], ["B", OPTIONS[1], true], ["C", OPTIONS[2], false]],
  );
});

test("a Linear question keeps its table, list and code lines", () => {
  // The Linear format drops blank lines and indentation inside a question
  // (see README, "Question format"). A table, a list and a fence still
  // render: each may follow a text line with no blank line between.
  const body = [
    "[agent:claude-code thr_abc123] Questions 2026-11-14",
    "",
    "Q1. Which runtime should velo use?",
    "| Load | Default | C |",
    "| --- | --- | --- |",
    "| Flood | 441k rec/s | -13% |",
    "Caveats:",
    "- one aarch64 host",
    "- `velo::rt` pinned",
    "```rust",
    "let rt = velo::Runtime::builder().build()?;",
    "```",
    "- A (recommended): Option C, `own_runtime(true)`.",
    "- B: Keep the **default**.",
  ].join("\n");
  const block = parseQuestionBlock({ id: "c1", body, createdAt: "2026-11-14T00:00:00Z", author: "user", parentId: null }, "checkin");
  assert.ok(block !== null && block.format === "parsed");
  const [question] = block.questions;
  assert.ok(question);
  assert.equal(
    question.text,
    [
      "Which runtime should velo use?",
      "| Load | Default | C |",
      "| --- | --- | --- |",
      "| Flood | 441k rec/s | -13% |",
      "Caveats:",
      "- one aarch64 host",
      "- `velo::rt` pinned",
      "```rust",
      "let rt = velo::Runtime::builder().build()?;",
      "```",
    ].join("\n"),
  );
  const { calls } = render(question.options);
  assert.deepEqual(
    calls.map((call) => call.content),
    ["Option C, `own_runtime(true)`.", "Keep the **default**."],
  );
});
