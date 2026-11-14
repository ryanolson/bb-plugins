import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables } from "./asks.ts";

test("table review F7: a nonbreaking space is not delimiter padding", () => {
  assert.deepEqual(brokenTables("| a | b |\n| --- | --- |\n| 1 | 2 |"), []);
  const text = "| a | b |\n| \u00a0--- | --- |\n| 1 | 2 |";
  assert.deepEqual(brokenTables(text), [1]);
});

test("table review F7: a nonbreaking space prevents a fence from closing", () => {
  const text = "```\n```\u00a0\n| a | b |\n| 1 | 2 |";
  assert.deepEqual(brokenTables(text), []);
});
