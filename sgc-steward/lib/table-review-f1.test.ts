import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

test("table review F1: an even backslash run leaves a pipe as a column boundary", () => {
  const text = [String.raw`| a\\| b |`, "| --- | --- |", "| 1 | 2 |"].join("\n");
  assert.deepEqual(brokenTables(text), []);
  assert.equal(tableWarning(text, []), null);
});

test("table review F1: count every column after an escaped backslash", () => {
  const text = [String.raw`| a\\| b | c |`, "| --- | --- |", "| 1 | 2 | 3 |"].join("\n");
  assert.deepEqual(brokenTables(text), [1]);
});
