// The choices a question card offers, worked out the same way on both sides:
// the page draws them, and the server turns the chosen letter back into its
// text. One function, so a letter the owner sees always names the same text
// on the server.
//
// Browser-safe: the page imports this module, so it must reach no `node:`
// builtin (see `lib/page-imports.test.ts`). The asker writes the options;
// this adds Pause, or for a question with none, the note to answer in.

/** The option every card offers last: stop this work and pick it up later. */
export const PAUSE_OPTION = "Pause it: stop this work for now, and resume it later.";

/**
 * The first choice of a question whose asker wrote no options: the owner
 * types the answer, and there is nothing else to pick but Pause. Its text
 * says so, and the page takes the note for it, never an empty answer.
 */
export const NOTE_OPTION = "Answer in the note below";

/** An option as a question stores it, and a choice as a card shows it. */
export interface Choice {
  letter: string;
  text: string;
  recommended: boolean;
}

/**
 * The choices to show for `options`, the asker's own: their order, their
 * text, their letters, and Pause last unless the asker wrote it. A letter is
 * never reused or moved, so the letter the owner picks names the same option
 * on the server as on the page. A question that offers no options offers the
 * note first, then Pause.
 */
export function cardChoices(options: readonly Choice[]): Choice[] {
  const choices: Choice[] =
    options.length === 0 ? [{ letter: "A", text: NOTE_OPTION, recommended: false }] : options.map(({ letter, text, recommended }) => ({ letter, text, recommended }));
  if (choices.some((choice) => choice.text === PAUSE_OPTION)) return choices;
  return [...choices, { letter: String.fromCharCode(65 + choices.length), text: PAUSE_OPTION, recommended: false }];
}

/** The choice a letter names, or undefined when the card has no such letter. */
export function choiceFor(options: readonly Choice[], letter: string): Choice | undefined {
  return cardChoices(options).find((choice) => choice.letter === letter);
}

/**
 * Whether this is the note a question with no options offers, where the note
 * is the answer: it must be typed, since nothing else would be posted. An
 * asker's own option whose text happens to read the same is just an option.
 */
export function isNoteChoice(options: readonly Choice[], choice: Choice | undefined): boolean {
  return choice !== undefined && options.length === 0 && choice.text === NOTE_OPTION;
}

/** Whether the letter names that note, so the page waits for the text before it can send. */
export function noteRequired(options: readonly Choice[], letter: string | null): boolean {
  return letter !== null && isNoteChoice(options, choiceFor(options, letter));
}
