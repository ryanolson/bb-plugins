// What a question card offers to pick. The page and the server both build the
// list with `cardChoices`, so a letter the owner sees names the same text on
// the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTE_OPTION, PAUSE_OPTION, cardChoices, noteRequired } from "./choices.ts";
import { askOptions } from "./asks.ts";

const texts = (choices: ReturnType<typeof cardChoices>) => choices.map((choice) => [choice.letter, choice.text]);

test("the asker's options come first, in order, then Pause", () => {
  assert.deepEqual(texts(cardChoices(askOptions(["Yes.", "No."], "A"))), [
    ["A", "Yes."],
    ["B", "No."],
    ["C", PAUSE_OPTION],
  ]);
  const three = cardChoices([
    { letter: "A", text: "Yes.", recommended: false },
    { letter: "B", text: "No.", recommended: true },
    { letter: "C", text: "Ask again later.", recommended: false },
  ]);
  assert.deepEqual(texts(three), [
    ["A", "Yes."],
    ["B", "No."],
    ["C", "Ask again later."],
    ["D", PAUSE_OPTION],
  ]);
  assert.deepEqual(three.map((choice) => choice.recommended), [false, true, false, false]);
});

test("a question with no options answers in the note, then pauses", () => {
  assert.deepEqual(cardChoices([]), [
    { letter: "A", text: NOTE_OPTION, recommended: false },
    { letter: "B", text: PAUSE_OPTION, recommended: false },
  ]);
  assert.equal(NOTE_OPTION, "Answer in the note below");
});

test("a Pause option the asker wrote is not added twice", () => {
  const stored = askOptions(["Yes.", "No."], "A");
  assert.deepEqual(cardChoices(stored), stored);
  const middle = [
    { letter: "A", text: PAUSE_OPTION, recommended: false },
    { letter: "B", text: "No.", recommended: true },
  ];
  assert.deepEqual(cardChoices(middle), middle);
});

test("an asker's own option that reads like the note is just an option", () => {
  const stored = [{ letter: "A", text: NOTE_OPTION, recommended: true }];
  assert.deepEqual(texts(cardChoices(stored)), [
    ["A", NOTE_OPTION],
    ["B", PAUSE_OPTION],
  ]);
  assert.equal(noteRequired(stored, "A"), false, "its note stays optional: the owner picked a written option");
  assert.equal(noteRequired([], "A"), true);
  assert.equal(noteRequired([], "B"), false, "Pause needs no note");
});

test("an ask stored before the note existed keeps its Pause letter, and gets the note in front", () => {
  const stored = [{ letter: "A", text: PAUSE_OPTION, recommended: false }];
  assert.deepEqual(texts(cardChoices(stored)), [
    ["B", NOTE_OPTION],
    ["A", PAUSE_OPTION],
  ], "the note is first, but Pause keeps A: an answer given before still means Pause");
  assert.equal(noteRequired(stored, "B"), true);
  assert.equal(noteRequired(stored, "A"), false, "Pause takes an optional note");
});

test("no added choice takes a letter past Z", () => {
  const letters = (count: number) => Array.from({ length: count }, (_, index) => ({ letter: String.fromCharCode(65 + index), text: `Route ${index}.`, recommended: false }));
  const twentyFive = cardChoices(letters(25));
  assert.equal(twentyFive.length, 26);
  assert.deepEqual(twentyFive.at(-1), { letter: "Z", text: PAUSE_OPTION, recommended: false }, "Z is the last free letter, so Pause takes it");
  const twentySix = cardChoices(letters(26));
  assert.deepEqual(twentySix.map((choice) => choice.letter), [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"], "all 26 are the asker's: no Pause, and no [");
  assert.ok(!twentySix.some((choice) => choice.text === PAUSE_OPTION));
});

test("the asker's options are left as stored, so a letter keeps its text", () => {
  const stored = [
    { letter: "B", text: "No.", recommended: true },
    { letter: "A", text: "Yes.", recommended: false },
  ];
  assert.deepEqual(texts(cardChoices(stored)), [
    ["B", "No."],
    ["A", "Yes."],
    ["C", PAUSE_OPTION],
  ]);
  const choices = cardChoices(stored);
  assert.notEqual(choices[0], stored[0], "the choices are copies, so the page draws no stale text");
  stored[0]!.text = "Changed.";
  assert.equal(choices[0]!.text, "No.");
});
