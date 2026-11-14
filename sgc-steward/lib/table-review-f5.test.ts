import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

test("table review F5: a fenced example inside a list is literal code", () => {
  const text = "- ```\n  | a | b |\n  | 1 | 2 |\n  ```";
  assert.deepEqual(brokenTables(text), []);
  assert.equal(tableWarning(text, []), null);
});

test("table review F5: a list's closing fence does not hide a following table", () => {
  const text = "- ```\n  | a | b |\n  | 1 | 2 |\n  ```\n\n| c | d |\n| 3 | 4 |";
  assert.deepEqual(brokenTables(text), [6]);
});
