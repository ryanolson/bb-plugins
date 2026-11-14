import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

test("table review F3: a multiline code span holds literal rows", () => {
  const rows = "| a | b |\n| 1 | 2 |";
  assert.deepEqual(brokenTables(rows), [1]);
  const text = `Compare this literal example: \`\n${rows}\n\``;
  assert.deepEqual(brokenTables(text), []);
  assert.equal(tableWarning(text, []), null);
});
