// SGC Steward frontend: the SGC page, its sidebar badge, and the notifier
// that tells you, once per question or todo, that new ones came. The page has
// a tab per list, each at its own route: Questions holds the two kinds of
// question, Linear blocks and bb questions agents asked with `bb sgc ask`, and
// Todos holds your todos from Linear.
//
// bb gives plugins no way to send a mobile push, so the notifier shows a
// system notification while bb is open in the background (with the browser's
// permission) and a bb toast otherwise. The badge is the lasting signal.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  Markdown,
  UrlLink,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import type { AskView, DeliveryView, IssueView, Panel, QuestionNotification, RecordView, TodoView, rpcContract } from "./lib/contract.ts";
import type { QuestionBlock } from "./lib/questions.ts";
import {
  announcement,
  askAnswerInput,
  filterCards,
  labelChoices,
  noticeTab,
  orderCards,
  PANEL_TABS,
  questionAnswerInput,
  questionBadge,
  sendsFor,
  sortCards,
  tabBadges,
  tabOf,
  tabPath,
  withDone,
  type AskDraft,
  type Card,
  type CardOrder,
  type LabelMatch,
  type PanelTab,
  type TabBadge,
} from "./lib/panel.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHANNEL = "questions";
const PANEL_PATH = "questions";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The last poll's questions and the bb questions, refetched whenever the server says they changed. */
function useQuestions() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Panel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("questions.list", null).then(
      (next) => {
        setSnapshot(next);
        setLoadError(null);
      },
      (cause: unknown) => setLoadError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(CHANNEL, load);
  return { rpc, snapshot, setSnapshot, loadError, load };
}

function useQuestionsBadge(): ExperimentalBadge | null {
  const { snapshot } = useQuestions();
  return snapshot === null ? null : questionBadge(snapshot);
}

function relativeTime(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleString();
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Notice({ tone = "neutral", children }: { tone?: "neutral" | "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        tone === "error" ? "border-destructive/40 text-destructive" : "border-dashed border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

// --- answering -----------------------------------------------------------

function textareaClass(): string {
  return "min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
}

function BlockHeader({ block }: { block: QuestionBlock }) {
  const navigate = useBbNavigate();
  const day = block.date ?? block.createdAt.slice(0, 10);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>
        {block.format === "parsed" ? "Questions" : "Question"} of {day} from {block.agent}
      </span>
      {block.threadId === null ? null : (
        <button
          type="button"
          className="cursor-pointer font-mono underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => navigate.toThread(block.threadId!)}
          title="Open the thread that asked"
        >
          {block.threadId}
        </button>
      )}
    </div>
  );
}

/** Pick an option, type an answer, or both: the fields of every question card. */
function AnswerFields({
  name,
  label,
  options,
  draft,
  onChange,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ letter: string; text: string; recommended: boolean }>;
  draft: AskDraft;
  onChange: (next: AskDraft) => void;
}) {
  return (
    <>
      {options.length === 0 ? null : (
        <div className="space-y-1.5">
          {options.map((option) => (
            <label
              key={option.letter}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
                draft.option === option.letter ? "border-foreground/50 bg-state-active" : "border-border hover:bg-state-hover",
              )}
            >
              <input type="radio" name={name} className="mt-0.5" checked={draft.option === option.letter} onChange={() => onChange({ ...draft, option: option.letter })} />
              <span className="font-mono">{option.letter}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
              {option.recommended ? <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">Recommended</span> : null}
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
      )}
      <textarea
        className={textareaClass()}
        value={draft.text}
        aria-label={label}
        placeholder={options.length === 0 ? "Type your answer" : draft.option === null ? "Or type your own answer" : "Add a note (optional)"}
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
      />
    </>
  );
}

/**
 * One open question of a Linear block, or a block not in the question
 * format, answered on its own. The answer names the block and the question,
 * so the block's other questions stay open, each on its own card.
 */
function LinearCard({ card, onAnswered }: { card: Extract<Card<IssueView, AskView>, { kind: "question" | "raw" }>; onAnswered: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<AskDraft>({ option: null, text: "" });
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { issue, block } = card;
  const input = questionAnswerInput(issue.id, block, card.kind === "question" ? card.question.number : null, draft);

  async function submit() {
    if (input === null) return;
    setPosting(true);
    setError(null);
    try {
      const result = await rpc.call("questions.answer", input);
      toast.success(`Posted the answer to ${result.identifier}`, result.warning === null ? {} : { description: result.warning });
      onAnswered();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <UrlLink href={issue.url} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
          {issue.identifier}
        </UrlLink>
        <h2 className="min-w-0 flex-1 text-sm font-medium">{issue.title}</h2>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
          {issue.kind === "checkin" ? "check-in" : "needs decision"}
        </span>
      </header>
      {issue.labels.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span key={label} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
      )}
      <BlockHeader block={block} />
      {card.kind === "raw" ? (
        <>
          <p className="text-xs text-muted-foreground">Not in the question format ({card.block.problem}), so it is shown as written.</p>
          <div className="rounded-md bg-secondary/40 px-3 py-2">
            <Markdown content={card.block.body} className="text-sm" />
          </div>
          <AnswerFields name={block.commentId} label="Answer" options={[]} draft={draft} onChange={setDraft} />
        </>
      ) : (
        <>
          {card.block.context === "" ? null : <Markdown content={card.block.context} className="text-sm text-muted-foreground" />}
          <div className="flex items-start gap-2 text-sm font-medium">
            <span className="shrink-0">Q{card.question.number}.</span>
            <Markdown content={card.question.text} className="min-w-0 flex-1" />
          </div>
          <AnswerFields
            name={`${block.commentId}-q${card.question.number}`}
            label={`Answer to Q${card.question.number}`}
            options={card.question.options}
            draft={draft}
            onChange={setDraft}
          />
        </>
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3">
        <Button disabled={posting || input === null} onClick={() => void submit()}>
          {posting ? "Posting…" : "Post answer to Linear"}
        </Button>
        {issue.kind === "needs-decision" ? (
          <span className="text-xs text-muted-foreground">Answering the last open question also removes the needs-decision label.</span>
        ) : null}
      </footer>
    </section>
  );
}

function AskCard({ ask, onAnswered }: { ask: AskView; onAnswered: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<AskDraft>({ option: null, text: "" });
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = askAnswerInput(ask.id, draft);
  const who = ask.threadTitle || ask.threadId;
  const options = [...ask.options].sort((a, b) => Number(b.recommended) - Number(a.recommended));

  async function submit() {
    if (input === null) return;
    setPosting(true);
    setError(null);
    try {
      const result = await rpc.call("asks.answer", input);
      if (result.delivered) toast.success(`Sent the answer to ${who}`);
      else toast.error(`Saved the answer, but could not send it to ${who}`, result.deliveryError === null ? {} : { description: result.deliveryError });
      if (result.record === "posted") toast.success(`Recorded it on ${ask.issue}`);
      if (result.record === "failed") toast.error(`Could not record it on ${ask.issue}`, result.recordError === null ? {} : { description: result.recordError });
      onAnswered();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">bb question</span>
        <button
          type="button"
          className="min-w-0 cursor-pointer font-medium underline-offset-2 hover:underline"
          onClick={() => navigate.toThread(ask.threadId)}
          title="Open the thread that asked"
        >
          {who}
        </button>
        <span className="font-mono text-xs text-muted-foreground">{ask.id}</span>
        {ask.labels.map((label) => (
          <span key={label} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {label}
          </span>
        ))}
        {ask.issue === null ? null : <span className="text-xs text-muted-foreground">issue {ask.issue}</span>}
      </header>
      <Markdown content={ask.question} className="text-sm" />
      <AnswerFields name={ask.id} label={`Answer to ${ask.id}`} options={options} draft={draft} onChange={setDraft} />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3">
        <Button disabled={posting || input === null} onClick={() => void submit()}>
          {posting ? "Sending…" : "Send answer"}
        </Button>
        <span className="text-xs text-muted-foreground">
          It goes to the asking thread as a message{ask.issue === null ? "." : `, and a record of it goes on ${ask.issue}.`}
        </span>
      </footer>
    </section>
  );
}

/** Answers saved but not sent to their thread, and records not posted to Linear, each with a retry. */
function Undelivered({ title, undelivered, unposted }: { title: string; undelivered: DeliveryView[]; unposted: RecordView[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  if (undelivered.length === 0 && unposted.length === 0) return null;

  async function retry(key: string, work: () => Promise<{ done: boolean; error: string | null }>) {
    setBusy(key);
    try {
      const { done, error } = await work();
      if (done) toast.success("Done");
      else toast.error("Still failing", error === null ? {} : { description: error });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  /** Stop listing a row; the server never sends or posts it again. Every open page drops it. */
  async function dismiss(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    try {
      await work();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  const dismissButton = (key: string, what: string, work: () => Promise<unknown>) => (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      disabled={busy !== null}
      aria-label={`Dismiss ${what}`}
      onClick={() => void dismiss(key, work)}
    >
      <Icon name="X" className="size-4" />
    </Button>
  );

  return (
    <section className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm">
      <h2 className="font-medium">{title}</h2>
      <p className="text-xs text-muted-foreground">
        A send that looked failed may still have arrived, so a retry can deliver it twice. Dismiss one with X to stop listing it; it is then never sent.
      </p>
      <ul className="space-y-2">
        {undelivered.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              {row.label} to <span className="font-mono">{row.threadId}</span>: {row.error ?? "not sent yet"} ({row.attempts}{" "}
              {row.attempts === 1 ? "try" : "tries"})
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void retry(row.id, async () => {
                  const result = await rpc.call("deliveries.retry", { id: row.id });
                  return { done: result.delivered, error: result.error };
                })
              }
            >
              {busy === row.id ? "Sending…" : "Send again"}
            </Button>
            {dismissButton(row.id, `${row.label} to ${row.threadId}`, () => rpc.call("deliveries.dismiss", { id: row.id }))}
          </li>
        ))}
        {unposted.map((row) => (
          <li key={row.askId} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              Record of {row.askId} on {row.issue}: {row.error ?? "not posted yet"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void retry(row.askId, async () => {
                  const result = await rpc.call("records.retry", { askId: row.askId });
                  return { done: result.posted, error: result.error };
                })
              }
            >
              {busy === row.askId ? "Posting…" : "Post again"}
            </Button>
            {dismissButton(row.askId, `the record of ${row.askId}`, () => rpc.call("records.dismiss", { askId: row.askId }))}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- todos -------------------------------------------------------------------

/** A Done from this page that can still be undone. */
interface DoneHere {
  issueId: string;
  identifier: string;
  title: string;
  undo: string;
}

function stewardToast(what: string, identifier: string, steward: "sent" | "failed" | "skipped"): void {
  if (steward === "sent") toast.success(`${what} ${identifier}, and told the steward`);
  else if (steward === "failed") toast.error(`${what} ${identifier}, but could not tell the steward`, { description: "Send the message again below." });
  else toast.success(`${what} ${identifier}`);
}

function TodoCard({ todo, onDone }: { todo: TodoView; onDone: (entry: DoneHere) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markDone() {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("todos.done", { issue: todo.id, note });
      stewardToast(result.resumed ? "Finished the earlier Done, with its own note, of" : "Marked done", todo.identifier, result.steward);
      onDone({ issueId: todo.id, identifier: todo.identifier, title: todo.title, undo: result.undo });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <UrlLink href={todo.url} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
          {todo.identifier}
        </UrlLink>
        <span className="min-w-0 flex-1 font-medium">{todo.title}</span>
        {todo.human ? <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">human</span> : null}
      </div>
      {todo.steps.length === 0 ? null : (
        <ul className="space-y-0.5 text-sm">
          {todo.steps.map((step, index) => (
            <li key={index} className={cn("flex gap-2", step.done && "text-muted-foreground line-through")}>
              <span aria-hidden>{step.done ? "☑" : "☐"}</span>
              <Markdown content={step.text} className="min-w-0 flex-1" />
            </li>
          ))}
        </ul>
      )}
      <textarea
        className={textareaClass()}
        value={note}
        aria-label={`Note for ${todo.identifier}`}
        placeholder="Add a note (optional)"
        onChange={(event) => setNote(event.target.value)}
      />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void markDone()}>
          {busy ? "Marking…" : "Done"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {todo.human ? "Comments as you, then moves the issue to Done." : "Comments as you, then removes the waiting label; the agents' work goes on."}
        </span>
      </footer>
    </li>
  );
}

/**
 * Your todos, and the ones done from this page, which can be undone while the
 * page stays open. `known` says Linear was read, so an empty list means none.
 */
function Todos({ todos, todoError, known }: { todos: TodoView[]; todoError: string | null; known: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [doneHere, setDoneHere] = useState<DoneHere[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function reopen(entry: DoneHere) {
    setBusy(entry.undo);
    try {
      const result = await rpc.call("todos.reopen", { undo: entry.undo });
      stewardToast("Reopened", entry.identifier, result.steward);
      setDoneHere((current) => current.filter((candidate) => candidate.undo !== entry.undo));
    } catch (cause) {
      toast.error(`Could not reopen ${entry.identifier}`, { description: errorText(cause) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3">
      {todoError === null ? null : <Notice tone="error">Could not read the todos: {todoError}</Notice>}
      {todos.length === 0 ? (
        known && todoError === null ? (
          <Notice>No todos.</Notice>
        ) : null
      ) : (
        <ul className="space-y-2">
          {todos.map((todo) => (
            <TodoCard key={todo.id} todo={todo} onDone={(entry) => setDoneHere((current) => withDone(current, entry))} />
          ))}
        </ul>
      )}
      {doneHere.length === 0 ? null : (
        <ul className="space-y-1 text-sm">
          {doneHere.map((entry) => (
            <li key={entry.undo} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-muted-foreground">
                Done: {entry.identifier} {entry.title}
              </span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void reopen(entry)}>
                {busy === entry.undo ? "Reopening…" : "Undo"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The tab bar: each tab with its open count, and a dot when something on it failed. */
function TabBar({ active, badges, onSelect }: { active: PanelTab; badges: Record<PanelTab, TabBadge> | null; onSelect: (tab: PanelTab) => void }) {
  return (
    <div role="tablist" aria-label="SGC Steward" className="flex gap-1 border-b border-border">
      {PANEL_TABS.map(({ id, label }) => {
        const badge = badges?.[id];
        const selected = id === active;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`sgc-tab-${id}`}
            aria-selected={selected}
            aria-controls={`sgc-panel-${id}`}
            className={cn(
              "-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium",
              selected ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => {
              if (!selected) onSelect(id);
            }}
          >
            {label}
            {badge === undefined || badge.count === 0 ? null : (
              <span className="rounded-full bg-secondary px-1.5 text-xs tabular-nums text-secondary-foreground">{badge.count}</span>
            )}
            {badge?.alert ? (
              <>
                <span aria-hidden className="size-2 rounded-full bg-destructive" />
                <span className="sr-only">, needs attention</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** A tab's content. The tabs not shown stay mounted, so drafts and the Undo list survive a switch. */
function TabPanel({ tab, active, children }: { tab: PanelTab; active: PanelTab; children: ReactNode }) {
  const shown = tab === active;
  return (
    <div role="tabpanel" id={`sgc-panel-${tab}`} aria-labelledby={`sgc-tab-${tab}`} hidden={!shown} className={cn("space-y-4", !shown && "hidden")}>
      {children}
    </div>
  );
}

/**
 * Label chips that filter the questions, a toggle between any of them and
 * all of them, as Linear's label filter has, a way to clear them, and the
 * order of the cards. Shown only once a question has a label, so the page
 * without labels looks as it did.
 */
function QuestionFilter({
  choices,
  chosen,
  match,
  order,
  onChosen,
  onMatch,
  onOrder,
}: {
  choices: string[];
  chosen: string[];
  match: LabelMatch;
  order: CardOrder;
  onChosen: (next: string[]) => void;
  onMatch: (next: LabelMatch) => void;
  onOrder: (next: CardOrder) => void;
}) {
  if (choices.length === 0) return null;
  const isChosen = (label: string) => chosen.some((candidate) => candidate.toLowerCase() === label.toLowerCase());
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Labels</span>
      <div role="group" aria-label="Match" className="flex overflow-hidden rounded-full border border-border">
        {(["any", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={match === value}
            className={cn("cursor-pointer px-2 py-0.5", match === value ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => onMatch(value)}
          >
            {value === "any" ? "Any of" : "All of"}
          </button>
        ))}
      </div>
      {choices.map((label) => (
        <button
          key={label}
          type="button"
          aria-pressed={isChosen(label)}
          className={cn(
            "cursor-pointer rounded-full border px-2 py-0.5",
            isChosen(label) ? "border-foreground bg-state-active text-foreground" : "border-border text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChosen(isChosen(label) ? chosen.filter((candidate) => candidate.toLowerCase() !== label.toLowerCase()) : [...chosen, label])}
        >
          {label}
        </button>
      ))}
      {chosen.length === 0 ? null : (
        <button
          type="button"
          className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onChosen([])}
        >
          Clear
        </button>
      )}
      <label className="ml-auto flex items-center gap-1 text-muted-foreground">
        Sort
        <select
          className="rounded border border-border bg-transparent px-1 py-0.5 text-foreground"
          value={order}
          onChange={(event) => onOrder(event.target.value === "label" ? "label" : "age")}
        >
          <option value="age">Oldest first</option>
          <option value="label">By label</option>
        </select>
      </label>
    </div>
  );
}

/** The SGC page: the last check and its trouble on top, then a tab per list. */
function SgcPage({ subPath }: { subPath: string }) {
  const { rpc, snapshot, setSnapshot, loadError, load } = useQuestions();
  const navigate = useBbNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);
  const tab = tabOf(subPath);
  const [chosen, setChosen] = useState<string[]>([]);
  const [match, setMatch] = useState<LabelMatch>("any");
  const [order, setOrder] = useState<CardOrder>("age");
  const cards = snapshot === null ? [] : sortCards(filterCards(orderCards(snapshot.issues, snapshot.asks), chosen, match), order);

  async function refresh() {
    setRefreshing(true);
    try {
      setSnapshot(await rpc.call("questions.refresh", null));
    } catch (cause) {
      toast.error(`Could not refresh: ${errorText(cause)}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">
            {snapshot === null
              ? "Loading…"
              : snapshot.checkedAt === null
                ? `Waiting for the first check of ${snapshot.teamKey}.`
                : `${snapshot.teamKey} checked ${relativeTime(snapshot.checkedAt, now)}.`}
          </span>
          <Button variant="outline" size="sm" disabled={refreshing || snapshot === null} onClick={() => void refresh()}>
            <Icon name="ArrowReloadHorizontal" className="size-4" />
            {refreshing ? "Checking…" : "Check now"}
          </Button>
        </div>
        {loadError === null ? null : <Notice tone="error">{loadError}</Notice>}
        {snapshot !== null && !snapshot.configured ? (
          <Notice>
            Set the Linear API key first. Pipe it in with <code>bb sgc key --api-key-stdin</code>, or paste it in Settings, Installed plugins, SGC
            Steward.
          </Notice>
        ) : null}
        {snapshot?.error ? (
          <Notice tone="error">
            Could not read Linear: {snapshot.error}
            {snapshot.issues.length > 0 || snapshot.todos.length > 0 ? " The lists below are from the last good check." : ""}
          </Notice>
        ) : null}
        <TabBar
          active={tab}
          badges={snapshot === null ? null : tabBadges(snapshot)}
          onSelect={(next) => navigate.toPluginPanel(PANEL_PATH, { subPath: tabPath(next) })}
        />
        <TabPanel tab="questions" active={tab}>
          {snapshot?.issueErrors.map((failed) => (
            <Notice key={failed.identifier} tone="error">
              Could not read {failed.identifier}: {failed.message}
            </Notice>
          ))}
          {snapshot === null ? null : (
            <Undelivered title="Answers that did not go out" undelivered={sendsFor("questions", snapshot.undelivered)} unposted={snapshot.unposted} />
          )}
          {snapshot === null ? null : (
            <QuestionFilter
              choices={labelChoices([...snapshot.issues, ...snapshot.asks], chosen)}
              chosen={chosen}
              match={match}
              order={order}
              onChosen={setChosen}
              onMatch={setMatch}
              onOrder={setOrder}
            />
          )}
          {snapshot !== null && snapshot.asks.length === 0 && snapshot.configured && snapshot.issues.length === 0 && snapshot.error === null ? (
            <Notice>No open questions.</Notice>
          ) : null}
          {chosen.length > 0 && cards.length === 0 ? (
            <Notice>No open questions have {match === "all" ? "every label chosen" : "any label chosen"}.</Notice>
          ) : null}
          {snapshot === null
            ? null
            : cards.map((card) =>
                card.kind === "ask" ? (
                  <AskCard key={card.ask.id} ask={card.ask} onAnswered={load} />
                ) : (
                  // An edit to the block changes its revision, which starts the card afresh on the new text.
                  <LinearCard
                    key={`${card.block.commentId}@${card.block.revision}#${card.kind === "question" ? card.question.number : "raw"}`}
                    card={card}
                    onAnswered={load}
                  />
                ),
              )}
        </TabPanel>
        <TabPanel tab="todos" active={tab}>
          {snapshot === null ? null : <Todos todos={snapshot.todos} todoError={snapshot.todoError} known={snapshot.configured && snapshot.error === null} />}
          {snapshot === null ? null : (
            <Undelivered title="Messages to the steward that did not go out" undelivered={sendsFor("todos", snapshot.undelivered)} unposted={[]} />
          )}
        </TabPanel>
      </div>
    </div>
  );
}

// --- notifications -------------------------------------------------------

function canShowSystemNotification(): boolean {
  if (typeof Notification === "undefined" || !window.isSecureContext) return false;
  // The mobile app's web view gets bb's own pushes only.
  const bb = (window as { bb?: unknown }).bb;
  if (typeof bb === "object" && bb !== null && "native" in bb) return false;
  return Notification.permission === "granted";
}

function announce(notes: QuestionNotification[], open: () => void): void {
  const { title, body } = announcement(notes);
  const inFront = document.visibilityState === "visible" && document.hasFocus();
  if (!inFront && canShowSystemNotification()) {
    try {
      const notification = new Notification(title, { body, tag: `sgc-steward-${notes[0]!.id}` });
      notification.onclick = () => {
        window.focus();
        open();
        notification.close();
      };
      return;
    } catch {
      // Some browsers only allow notifications from a service worker; the
      // toast below still reaches the notification center.
    }
  }
  toast(title, { description: body, action: { label: "Open", onClick: open } });
}

/**
 * Mounted in every bb window. The server hands each new block to exactly one
 * claim, so a block is announced once however many windows are open; a
 * window that opens later picks up what nobody claimed.
 */
function Notifier() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const deliver = useCallback(() => {
    rpc.call("notifications.claim", null).then(
      ({ notifications }) => {
        if (notifications.length > 0) announce(notifications, () => navigate.toPluginPanel(PANEL_PATH, { subPath: tabPath(noticeTab(notifications)) }));
      },
      () => undefined,
    );
  }, [rpc, navigate]);
  useEffect(deliver, [deliver]);
  const onSignal = useMemo(
    () => (payload: unknown) => {
      const fresh = typeof payload === "object" && payload !== null && "newBlocks" in payload ? Number(payload.newBlocks) : 0;
      if (fresh > 0) deliver();
    },
    [deliver],
  );
  useRealtime(CHANNEL, onSignal);
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "questions",
    title: "SGC questions",
    icon: "MessageQuestion",
    path: PANEL_PATH,
    component: SgcPage,
    experimental_useBadge: useQuestionsBadge,
  });
  app.slots.experimental_appOverlay({ id: "notifier", component: Notifier });
});
