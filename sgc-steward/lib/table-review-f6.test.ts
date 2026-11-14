import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables } from "./asks.ts";

test("table review F6: triple backticks with backticks in their text are not a fence", () => {
  const text = "```Use `x` for names```\n\n| a | b |\n| 1 | 2 |";
  assert.deepEqual(brokenTables(text), [3]);
});
