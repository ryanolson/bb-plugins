import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

test("table review F2: body rows belong to the table above an unbordered delimiter", () => {
  const text = "| a | b |\n--- | ---\n| 1 | 2 |\n| 3 | 4 |";
  assert.deepEqual(brokenTables(text), []);
  assert.equal(tableWarning(text, []), null);
});
