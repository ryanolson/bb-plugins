import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_LIMITS, askOptions, checkLabels, checkQuestion, labelWarning, PAUSE_OPTION } from "./asks.ts";

const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

test("a question may hold 80 words and no more", () => {
  assert.equal(checkQuestion(words(80)), words(80));
  assert.throws(() => checkQuestion(words(81)), /at most 80 words/);
  assert.throws(() => checkQuestion(`${words(40)}\n\n${words(41)}`), /at most 80 words/, "any whitespace splits words");
  assert.throws(() => checkQuestion("x".repeat(ASK_LIMITS.questionChars + 1)), /characters/, "the character cap stays");
});

test("a question takes 3 options of 25 words, and the Pause option comes last and is never recommended", () => {
  const three = askOptions(["a", "b", words(25)], "B");
  assert.deepEqual(three.map((option) => [option.letter, option.recommended]), [["A", false], ["B", true], ["C", false], ["D", false]]);
  assert.equal(three.at(-1)!.text, PAUSE_OPTION);
  assert.equal(PAUSE_OPTION, "Pause it: stop this work for now, and resume it later.");
  assert.throws(() => askOptions(["a", "b", "c", "d"], null), /at most 3 options/);
  assert.throws(() => askOptions([words(26)], null), /option A is over 25 words/);
  assert.throws(() => askOptions(["a"], "B"), /no option B to recommend/, "the Pause option cannot be recommended");
});

test("no options still leaves the Pause option, as option A", () => {
  assert.deepEqual(askOptions([], null), [{ letter: "A", text: PAUSE_OPTION, recommended: false }]);
});

test("exactly one label is taken: none and two are refused", () => {
  assert.deepEqual(checkLabels(["Release"], null), ["Release"]);
  assert.throws(() => checkLabels([], null), /exactly 1 label/);
  assert.throws(() => checkLabels(["a", "b"], null), /exactly 1 label/);
  assert.throws(() => checkLabels(["a", "A"], null), /exactly 1 label/, "the same label twice is still two");
  assert.throws(() => checkLabels(["x".repeat(81)], null), /over 80 characters/);
  assert.deepEqual(checkLabels(["x".repeat(80)], null), ["x".repeat(80)]);
});

test("with a project list the label must name one of its projects, in any case", () => {
  const projects = ["Operator tooling: lean restart", "GDL: cells"];
  assert.deepEqual(checkLabels(["gdl: CELLS"], projects), ["gdl: CELLS"]);
  assert.throws(() => checkLabels(["Nope"], projects), /not the name of an open Linear project.*Operator tooling: lean restart/);
  assert.throws(() => checkLabels(["Anything"], []), /not the name of an open Linear project/, "an empty list is a loaded list");
});

test("with no project list any label is taken, and a warning says it was not checked", () => {
  assert.deepEqual(checkLabels(["whatever"], null), ["whatever"]);
  assert.match(labelWarning(null)!, /^Warning: .*not checked/);
  assert.equal(labelWarning(["GDL: cells"]), null);
});
