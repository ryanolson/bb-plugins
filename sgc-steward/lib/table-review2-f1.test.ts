import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

const ROWS = "| a | b |\n| 1 | 2 |";

test("table review 2 F1 control: ordinary inline HTML keeps rows as prose", () => {
  assert.deepEqual(brokenTables(ROWS), [1]);
  assert.deepEqual(brokenTables(`Example <span>\n${ROWS}\n</span>`), [2]);
});

for (const tag of ["pre", "code"]) {
  test(`table review 2 F1: inline ${tag} content holds literal rows`, () => {
    // bb's raw HTML renderer puts these rows inside the pre or code element.
    const text = `Example <${tag}>\n${ROWS}\n</${tag}>`;
    assert.deepEqual(brokenTables(text), []);
    assert.equal(tableWarning(text, []), null);
    assert.deepEqual(brokenTables(`${text}\n\n${ROWS}`), [6]);
  });
}
