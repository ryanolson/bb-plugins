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
