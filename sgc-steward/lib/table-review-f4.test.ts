import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

test("table review F4: raw preformatted HTML holds literal rows", () => {
  const text = "<pre>\n| a | b |\n| 1 | 2 |\n</pre>";
  assert.deepEqual(brokenTables(text), []);
  assert.equal(tableWarning(text, []), null);
});

test("table review F4: an HTML comment cannot open a Markdown code fence", () => {
  const text = "<!--\n```\n-->\n\n| a | b |\n| 1 | 2 |";
  assert.deepEqual(brokenTables(text), [5]);
});
