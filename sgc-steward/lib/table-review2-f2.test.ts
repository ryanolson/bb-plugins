import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTables, tableWarning } from "./asks.ts";

const ROWS = "| a | b |\n| 1 | 2 |";

test("table review 2 F2 control: visible link labels count, reference titles do not", () => {
  assert.deepEqual(brokenTables(`[label\n${ROWS}\n](https://example.com)`), [2]);
  assert.deepEqual(brokenTables(`[label][ref]\n\n[ref]: https://example.com "Title\n${ROWS}\n"`), []);
});

for (const label of ["[label]", "![alt]"]) {
  test(`table review 2 F2: the multiline title after ${label} is metadata`, () => {
    // bb renders the title as an attribute, with no pipe rows in the paragraph.
    const text = `${label}(https://example.com "Title\n${ROWS}\n")`;
    assert.deepEqual(brokenTables(text), []);
    assert.equal(tableWarning(text, []), null);
    assert.deepEqual(brokenTables(`${text}\n\n${ROWS}`), [6]);
  });
}
