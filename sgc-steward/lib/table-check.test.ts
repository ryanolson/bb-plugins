// A table with no delimiter row shows as plain text on the page, because
// bb's Markdown (remark-gfm) needs `| --- |` under the header row. `bb sgc
// ask` warns about it and stores the question as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

/** The shape of the velo question that showed raw: rows, no delimiter row. */
const VELO = [
  "Cost, medians, default vs C:",
  "| Load | Default | C |",
  "| Unary, 1 caller, p50 | 15.7 us | 55.7 us |",
  "| Flood | 441k rec/s | -13% |",
  "",
  "Gains, medians, default vs C:",
  "| 64 streams, 1 peer | 347k rec/s | 487k rec/s |",
  "| Unary, 64 callers | 223k calls/s | 428k calls/s |",
].join("\n");

test("rows with no delimiter row are a broken table, named by the header's line", () => {
  assert.deepEqual(brokenTables(VELO), [2, 7]);
});

test("a table with its delimiter row is fine, with or without a blank line or alignment", () => {
  const tables = [
    "Cost:\n| Load | Default |\n| --- | --- |\n| Flood | 441k |",
    "Cost:\n\n| Load | Default |\n|:---|---:|\n| Flood | 441k |",
    "| Load | Default |\n| :-: | - |",
    "|a|b|\n|-|-|\n|1|2|",
    "| Cell with \\| a pipe | b |\n| --- | --- |\n| 1 | 2 |",
    "  | Indented | two spaces |\n  | --- | --- |",
  ];
  for (const text of tables) assert.deepEqual(brokenTables(text), [], text);
});

test("pipes inside a code fence are not a table", () => {
  const fenced = [
    "```\n| a | b |\n| 1 | 2 |\n```",
    "~~~text\n| a | b |\n| 1 | 2 |\n~~~",
    "````md\n| a | b |\n```\n| 1 | 2 |\n````",
  ];
  for (const text of fenced) assert.deepEqual(brokenTables(text), [], text);
  // A row after the fence closes counts again.
  assert.deepEqual(brokenTables("```\nx\n```\n| a | b |\n| 1 | 2 |"), [4]);
});

test("a delimiter row with the wrong number of cells is no delimiter row", () => {
  assert.deepEqual(brokenTables("| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |"), [1]);
});

test("one pipe row alone, or lines that only start with a pipe, are not a table", () => {
  assert.deepEqual(brokenTables("| just one row |"), []);
  assert.deepEqual(brokenTables("| a\n| b"), []);
  assert.deepEqual(brokenTables("Text | with | pipes\nmore | pipes"), []);
  // Four spaces of indent make an indented code line, not a table row.
  assert.deepEqual(brokenTables("    | a | b |\n    | 1 | 2 |"), []);
});

test("the warning names the question and each option with a broken table, in one line", () => {
  assert.equal(tableWarning("Plain question?", ["Yes.", "No."]), null);
  const warning = tableWarning(VELO, ["Fine.", "| a | b |\n| 1 | 2 |"]);
  assert.ok(warning !== null);
  assert.doesNotMatch(warning, /\n/);
  assert.match(warning, /the question \(lines 2, 7\)/);
  assert.match(warning, /option B \(line 1\)/);
  assert.match(warning, /\| --- \|/);
  assert.match(warning, /stored as written/);
});

test("pipes inside a math block are not a table, as bb's renderer reads them", () => {
  assert.deepEqual(brokenTables("$$\n| a | b |\n| 1 | 2 |\n$$"), []);
  // Single dollars stay text in bb, so rows after one still count.
  assert.deepEqual(brokenTables("Costs $5\n\n| a | b |\n| 1 | 2 |"), [3]);
});

test("a broken table inside a paragraph is found below its lead-in text", () => {
  assert.deepEqual(brokenTables("Lead-in text\nmore text\n| a | b |\n| 1 | 2 |\ntrailing text"), [3]);
});
