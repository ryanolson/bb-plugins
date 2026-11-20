// The answer controls a question card shows: its choices as radios, then a box
// for a typed answer or a note. Linear and bb question cards share them. The
// choices come from `cardChoices`, so a card with no options still offers the
// note, and then Pause.
//
// Agents write the options, so each goes through bb's Markdown renderer, like
// the question text: tables, lists and code render, and bb's sanitizer drops
// any raw HTML that could run. Never render option text as HTML here.
import { Markdown } from "@get-bb/plugin-sdk/app";
import { cardChoices, isNoteChoice, type Choice } from "@/lib/choices";
import type { AskDraft } from "@/lib/panel";
import { cn } from "@/lib/utils";

export function textareaClass(): string {
  return "min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
}

export function AnswerFields({
  name,
  label,
  options,
  draft,
  onChange,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<Choice>;
  draft: AskDraft;
  onChange: (next: AskDraft) => void;
}) {
  // Always a radio list: a question with no options still offers the note, and
  // then Pause, and the note is where its answer goes.
  const choices = cardChoices(options);
  const note = isNoteChoice(options, choices.find((choice) => choice.letter === draft.option));
  return (
    <>
      <div className="space-y-1.5">
        {choices.map((choice) => (
          <label
            key={choice.letter}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
              draft.option === choice.letter ? "border-foreground/50 bg-state-active" : "border-border hover:bg-state-hover",
            )}
          >
            <input type="radio" name={name} className="mt-0.5" checked={draft.option === choice.letter} onChange={() => onChange({ ...draft, option: choice.letter })} />
            <span className="font-mono">{choice.letter}</span>
            <Markdown content={choice.text} className="min-w-0 flex-1" />
            {choice.recommended ? <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">Recommended</span> : null}
          </label>
        ))}
        {draft.option === null ? null : (
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => onChange({ ...draft, option: null })}
          >
            Clear choice
          </button>
        )}
      </div>
      <textarea
        className={textareaClass()}
        value={draft.text}
        aria-label={label}
        placeholder={note ? "Type your answer" : "Add a note (optional)"}
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
      />
    </>
  );
}
