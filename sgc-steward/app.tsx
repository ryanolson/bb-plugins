// SGC Steward frontend: the SGC page, its sidebar badge, and the notifier
// that tells you, once per question or todo, that new ones came. The page has
// a tab per list, each at its own route: Questions holds the two kinds of
// question, Linear blocks and bb questions agents asked with `bb sgc ask`, and
// Todos holds your todos from Linear. Paused lists work that stopped, with a Resume button. Hosts shows each host's threads against
// bb's concurrency limit, read only. Threads shows each thread's lifecycle state, its prompt cache countdown, and the plugin's decision.
//
// bb gives plugins no way to send a mobile push, so the notifier shows a
// system notification while bb is open in the background (with the browser's
// permission) and a bb toast otherwise. The badge is the lasting signal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { AskView, DeliveryView, ExpiredView, IssueView, Panel, PausedView, QuestionNotification, RecordView, TodoView, rpcContract } from "./lib/contract.ts";
import { appLink } from "./lib/links.ts";
import type { QuestionBlock } from "./lib/questions.ts";
import { limitText, UNPLACED_NAME, waitText, type HostsView } from "./lib/hosts.ts";
import {
  buttonRefusal,
  groupByHost,
  rowText,
  summarize,
  summaryText,
  type DecisionRow,
  type RowAction,
  type StateTone,
  type ThreadRowView,
  type ThreadsView,
} from "./lib/threads-view.ts";
import { ARCHIVE_CHANNEL, coverageText, parentText, startedText, type ArchiveRowView, type ArchiveView } from "./lib/archive-view.ts";
import {
  announcement,
  askAnswerInput,
  filterCards,
  hostsBadge,
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
  threadsBadge,
  withDone,
  type AskDraft,
  type Card,
  type CardOrder,
  type LabelMatch,
  type PanelTab,
  type TabBadge,
} from "./lib/panel.ts";
import { AnswerFields, textareaClass } from "@/components/answer-fields";
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
        <UrlLink href={appLink(issue.url)} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
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
          {/* A block not in the question format has no options of its own, so its
              card offers the note and Pause, as a question with none does. */}
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
  const input = askAnswerInput(ask.id, draft, ask.options);
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
        <UrlLink href={appLink(todo.url)} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
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

// --- paused ------------------------------------------------------------------

/** Question ids the owner dismissed from the Paused tab. Kept in this browser only: dismissing changes nothing on Linear or in the plugin. */
const DISMISSED_KEY = "sgc-steward.dismissed-expired";

function readDismissed(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The expired questions the owner has not dismissed, and the way to dismiss one. */
function useDismissed(): [string[], (id: string) => void] {
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const dismiss = useCallback((id: string) => {
    setDismissed((current) => {
      const next = current.includes(id) ? current : [...current, id].slice(-200);
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // A browser that keeps nothing still hides the row until the page reloads.
      }
      return next;
    });
  }, []);
  return [dismissed, dismiss];
}

/** Resume one issue, from a paused row or from an expired question that names it. */
function ResumeBox({ issue, onResumed }: { issue: string; onResumed: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("paused.resume", { issue, note });
      stewardToast("Resumed", result.identifier, result.steward);
      onResumed();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <textarea
        className={textareaClass()}
        value={note}
        aria-label={`Note for ${issue}`}
        placeholder="Add a note (optional)"
        onChange={(event) => setNote(event.target.value)}
      />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void resume()}>
          {busy ? "Resuming…" : "Resume"}
        </Button>
        <span className="text-xs text-muted-foreground">Comments as you, removes the paused label, and moves the issue to Todo. The work restarts from the branch in the pause comment.</span>
      </footer>
    </>
  );
}

function PausedCard({ issue, onResumed }: { issue: PausedView; onResumed: () => void }) {
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <UrlLink href={appLink(issue.url)} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
          {issue.identifier}
        </UrlLink>
        <span className="min-w-0 flex-1 font-medium">{issue.title}</span>
        {issue.state === null ? null : <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">{issue.state}</span>}
      </div>
      <ResumeBox issue={issue.identifier} onResumed={onResumed} />
    </li>
  );
}

function ExpiredCard({ ask, issueUrl, onDismiss, onResumed }: { ask: ExpiredView; issueUrl: string | null; onDismiss: () => void; onResumed: () => void }) {
  return (
    <li className="space-y-2 rounded-md border border-dashed border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span className="font-mono text-xs">{ask.id}</span>
        <span className="min-w-0 flex-1">
          Expired with no answer · {ask.threadTitle || ask.threadId}
          {ask.issue === null ? null : (
            <>
              {" · "}
              {issueUrl === null ? (
                ask.issue
              ) : (
                <UrlLink href={appLink(issueUrl)} className="font-mono underline-offset-2 hover:underline">
                  {ask.issue}
                </UrlLink>
              )}
            </>
          )}
        </span>
      </div>
      <Markdown content={ask.question} className="text-sm" />
      {ask.issue === null ? null : <ResumeBox issue={ask.issue} onResumed={onResumed} />}
      <footer className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
        <span className="text-xs text-muted-foreground">Hides this row in this browser only.</span>
      </footer>
    </li>
  );
}

/** Work that stopped: open issues with the paused label, and questions that expired with no answer in the last 14 days. */
function Paused({
  paused,
  expired,
  pausedError,
  known,
  onChanged,
  onDismiss,
}: {
  paused: PausedView[];
  expired: ExpiredView[];
  pausedError: string | null;
  known: boolean;
  onChanged: () => void;
  onDismiss: (id: string) => void;
}) {
  const urls = new Map(paused.map((issue) => [issue.identifier, issue.url]));
  return (
    <section className="space-y-3">
      {pausedError === null ? null : <Notice tone="error">Could not read the paused issues: {pausedError}</Notice>}
      {paused.length === 0 && expired.length === 0 ? known && pausedError === null ? <Notice>Nothing is paused.</Notice> : null : null}
      {paused.length === 0 ? null : (
        <ul className="space-y-2">
          {paused.map((issue) => (
            <PausedCard key={issue.id} issue={issue} onResumed={onChanged} />
          ))}
        </ul>
      )}
      {expired.length === 0 ? null : <h3 className="pt-2 text-sm font-medium text-muted-foreground">Questions that expired with no answer</h3>}
      {expired.length === 0 ? null : (
        <ul className="space-y-2">
          {expired.map((ask) => (
            <ExpiredCard key={ask.id} ask={ask} issueUrl={ask.issue === null ? null : (urls.get(ask.issue) ?? null)} onDismiss={() => onDismiss(ask.id)} onResumed={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The tab bar: each tab with its open count, and a dot when something on it failed. */
function TabBar({ active, badges, onSelect }: { active: PanelTab; badges: Partial<Record<PanelTab, TabBadge>>; onSelect: (tab: PanelTab) => void }) {
  return (
    <div role="tablist" aria-label="SGC Steward" className="flex gap-1 border-b border-border">
      {PANEL_TABS.map(({ id, label }) => {
        const badge = badges[id];
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

// --- hosts ----------------------------------------------------------------

const HOSTS_REFRESH_MS = 30_000;

/** The Hosts view: read once for the tab's badge, and every 30 seconds while the tab is open. */
function useHosts(active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<HostsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loads overlap when the tab opens or Refresh is pressed; only the newest may land, so an older read never replaces newer counts.
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    rpc.call("hosts.list", null).then(
      (next) => {
        if (request !== latest.current) return;
        setView(next);
        setError(null);
      },
      (cause: unknown) => {
        if (request === latest.current) setError(errorText(cause));
      },
    );
  }, [rpc]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(load, HOSTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return { view, error, load };
}

function HostCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-2 py-1.5 tabular-nums", className)}>{children}</td>;
}

/** The Hosts tab: the same rows and numbers as `bb sgc hosts`, from the same view model. */
function Hosts({ view, error, onRefresh, now }: { view: HostsView | null; error: string | null; onRefresh: () => void; now: number }) {
  const loose = view?.unplaced;
  return (
    <>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">
          {view === null
            ? "Loading…"
            : `Checked ${relativeTime(view.checkedAt, now)}. Global limit: ${view.globalLimit === null ? "none" : `${view.globalLimit}${view.globalAtLimit ? ", reached" : ""}`}. Running: ${view.running}.`}
        </span>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <Icon name="ArrowReloadHorizontal" className="size-4" />
          Refresh
        </Button>
      </div>
      {error === null ? null : <Notice tone="error">Could not read bb: {error}</Notice>}
      {view?.limitError ? <Notice tone="error">Could not read the limits: {view.limitError}</Notice> : null}
      {view === null ? null : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {["Host", "Status", "Running", "Idle", "Waiting", "Oldest wait", "Limit"].map((title) => (
                  <th key={title} scope="col" className="px-2 py-1.5 font-medium">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.hosts.map((host) => (
                <tr key={host.id} className={cn("border-t border-border", host.status !== "connected" && "text-muted-foreground")}>
                  <HostCell>
                    <span title={host.id}>{host.name}</span>
                  </HostCell>
                  <HostCell>{host.status}</HostCell>
                  <HostCell>{host.running}</HostCell>
                  <HostCell>{host.idle}</HostCell>
                  <HostCell className={cn(host.waiting > 0 && "font-medium text-destructive")}>{host.waiting}</HostCell>
                  <HostCell>{waitText(host.oldestWaitMs)}</HostCell>
                  <HostCell className={cn(host.atLimit && "font-medium")}>{limitText(host)}</HostCell>
                </tr>
              ))}
              {loose === undefined || loose.running + loose.idle + loose.waiting === 0 ? null : (
                <tr className="border-t border-border text-muted-foreground">
                  <HostCell>{UNPLACED_NAME}</HostCell>
                  <HostCell>-</HostCell>
                  <HostCell>{loose.running}</HostCell>
                  <HostCell>{loose.idle}</HostCell>
                  <HostCell>{loose.waiting}</HostCell>
                  <HostCell>{waitText(loose.oldestWaitMs)}</HostCell>
                  <HostCell>-</HostCell>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Read only. Running threads are starting or active. Waiting counts the threads whose turn bb holds at a limit, with how long the oldest has been
        queued. Set a limit with <code>bb concurrency-limit host</code>.
      </p>
    </>
  );
}

// --- threads --------------------------------------------------------------

const THREADS_REFRESH_MS = 30_000;

/** The thread lifecycle snapshot and log: read once for the tab's badge, and every 30 seconds while the tab is open. */
function useThreads(active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{ view: ThreadsView | null; log: DecisionRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest read may land, so an older one never replaces newer rows.
  const latest = useRef(0);
  const load = useCallback(
    (refresh = false) => {
      const request = ++latest.current;
      rpc.call("threads.list", { refresh }).then(
        (next) => {
          if (request !== latest.current) return;
          setData(next);
          setError(null);
        },
        (cause: unknown) => {
          if (request === latest.current) setError(errorText(cause));
        },
      );
    },
    [rpc],
  );
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(load, THREADS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return { data, error, load };
}

const TONE_CLASS: Record<StateTone, string> = {
  active: "bg-primary/10 text-primary",
  neutral: "bg-secondary text-secondary-foreground",
  quiet: "text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  critical: "bg-destructive/10 text-destructive",
};

const ACTION_LABEL: Record<RowAction, string> = { keep: "Keep", compact: "Compact now", archive: "Archive now" };

function ThreadRow({ thread, log, now, onChanged }: { thread: ThreadRowView; log: DecisionRow[]; now: number; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<RowAction | null>(null);
  const text = rowText(thread, now, log);

  async function run(action: RowAction) {
    if (action === "archive" && !window.confirm(`Archive ${text.title}? bb removes its worktree 5 minutes later.`)) return;
    setBusy(action);
    try {
      const done = await rpc.call("threads.act", { threadId: thread.id, action });
      toast.success(done.message);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-2 py-1.5">
        <button type="button" className="cursor-pointer text-left font-medium underline-offset-2 hover:underline" title={thread.id} onClick={() => navigate.toThread(thread.id)}>
          {text.title}
        </button>
      </td>
      <td className="px-2 py-1.5">
        <span className={cn("rounded-full px-2 py-0.5 text-xs", TONE_CLASS[text.stateTone])} title={thread.stateReason}>
          {text.state}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-xs">
        {text.issue === null ? (
          "-"
        ) : (
          <UrlLink href={text.issue.href} className="underline-offset-2 hover:underline">
            {text.issue.identifier}
          </UrlLink>
        )}
      </td>
      <td className="px-2 py-1.5 text-xs">{text.providerModel}</td>
      <td className="px-2 py-1.5 text-xs tabular-nums">{text.tokens}</td>
      <td className={cn("px-2 py-1.5 tabular-nums", text.expires === "cold" && "text-muted-foreground")}>{text.expires}</td>
      <td className="px-2 py-1.5">
        <span className="font-medium">{text.decision}</span>
        <div className="max-w-64 text-xs text-muted-foreground">{text.reason}</div>
      </td>
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{text.lastAction}</td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          {(["keep", "compact", "archive"] as const).map((action) => {
            const refusal = buttonRefusal(thread, action);
            return (
              // A disabled button shows no tooltip of its own, so the reason goes on its wrapper.
              <span key={action} title={refusal ?? undefined}>
                <Button variant="outline" size="sm" disabled={busy !== null || refusal !== null} onClick={() => void run(action)}>
                  {busy === action ? "Working…" : ACTION_LABEL[action]}
                </Button>
              </span>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

/** The Threads tab: a summary, the threads grouped by host with the soonest cache expiry first, and the decision log. */
function Threads({
  data,
  error,
  onRefresh,
  onChanged,
  now,
}: {
  data: { view: ThreadsView | null; log: DecisionRow[] } | null;
  error: string | null;
  onRefresh: () => void;
  onChanged: () => void;
  now: number;
}) {
  const view = data?.view ?? null;
  const log = data?.log ?? [];
  return (
    <>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">{view === null ? "Loading…" : summaryText(summarize(view, now))}</span>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <Icon name="ArrowReloadHorizontal" className="size-4" />
          Refresh
        </Button>
      </div>
      {error === null ? null : <Notice tone="error">Could not read threads: {error}</Notice>}
      {view?.linearError ? <Notice tone="error">{view.linearError} Threads show no issue until it can be read.</Notice> : null}
      {view === null
        ? null
        : groupByHost(view.threads).map((group) => (
            <div key={group.hostId ?? "none"} className="space-y-1">
              <h3 className="text-sm font-medium">{group.name}</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      {["Thread", "State", "Issue", "Provider/model", "Tokens", "Cache expires in", "Decision", "Last action", ""].map((title) => (
                        <th key={title} scope="col" className="px-2 py-1.5 font-medium">
                          {title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.threads.map((thread) => (
                      <ThreadRow key={thread.id} thread={thread} log={log} now={now} onChanged={onChanged} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      {view !== null && view.threads.length === 0 ? <Notice>No threads.</Notice> : null}
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Decision log</h3>
        {log.length === 0 ? (
          <Notice>No decisions yet. The plugin decides in the last minutes before a thread's cache expires.</Notice>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  {["Time", "Thread", "Decision", "Reason", "Result"].map((title) => (
                    <th key={title} scope="col" className="px-2 py-1.5 font-medium">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums">{new Date(entry.at).toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-xs" title={entry.threadId}>
                      {entry.threadTitle || entry.threadId}
                    </td>
                    <td className="px-2 py-1.5">{entry.decision}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{entry.reason}</td>
                    <td className={cn("px-2 py-1.5 text-xs", entry.result === "failed" && "text-destructive")}>
                      {entry.result === "failed" ? `failed: ${entry.error ?? "unknown error"}` : entry.result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Each provider keeps a thread's prompt cache for a while after its last turn. Keep protects a thread for 24 hours. Compact now and Archive now run
        the same safety checks as the plugin does, and say why when they refuse.
      </p>
    </>
  );
}

// --- archive --------------------------------------------------------------

/** The Archive tab's rows: read when the tab opens, and again whenever the server writes an archive row. */
function useArchive(active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ArchiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    rpc.call("archive.list", null).then(
      (next) => {
        if (request !== latest.current) return;
        setView(next);
        setError(null);
      },
      (cause: unknown) => {
        if (request === latest.current) setError(errorText(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useRealtime(
    ARCHIVE_CHANNEL,
    useCallback(() => {
      if (active) load();
    }, [active, load]),
  );
  return { view, error };
}

function ThreadLink({ threadId, children }: { threadId: string; children: ReactNode }) {
  const navigate = useBbNavigate();
  return (
    <button type="button" className="cursor-pointer text-left underline-offset-2 hover:underline" title={threadId} onClick={() => navigate.toThread(threadId)}>
      {children}
    </button>
  );
}

function ArchiveRow({ row }: { row: ArchiveRowView }) {
  const { record } = row;
  const parent = parentText(row.parent);
  return (
    <tr className="border-t border-border align-top">
      <td className="px-2 py-1.5">
        <div className="font-medium">
          <ThreadLink threadId={record.threadId}>{record.title || record.threadId}</ThreadLink>
        </div>
        {record.issue === null ? null : (
          <div className="font-mono text-xs">
            {record.issue.url === null ? (
              record.issue.identifier
            ) : (
              <UrlLink href={appLink(record.issue.url)} className="underline-offset-2 hover:underline">
                {record.issue.identifier}
              </UrlLink>
            )}
          </div>
        )}
        {parent === null ? null : (
          <div className={cn("text-xs", row.parent?.status === "missing" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
            {row.parent?.status === "missing" ? parent : <ThreadLink threadId={row.parent!.threadId}>{parent}</ThreadLink>}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums">
        <div>{startedText(record)}</div>
        <div>archived {new Date(record.archivedAt).toLocaleString()}</div>
      </td>
      <td className="max-w-64 px-2 py-1.5 text-xs">{row.why}</td>
      <td className="max-w-72 px-2 py-1.5 text-xs">
        <div>{row.summary}</div>
        {row.note === null ? null : <div className="text-amber-700 dark:text-amber-400">{row.note}</div>}
        {row.children.length === 0 ? null : (
          <div className="mt-1 flex flex-wrap gap-x-2 text-muted-foreground">
            {row.children.map((child) => (
              <span key={child.threadId} title={`${child.title}: ${child.fate}`}>
                <ThreadLink threadId={child.threadId}>
                  {child.phase} {child.name}
                </ThreadLink>
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-2 py-1.5 text-xs tabular-nums">
        <div>{row.tokens}</div>
        {row.phaseTokens === null ? null : <div className="text-muted-foreground">{row.phaseTokens}</div>}
      </td>
    </tr>
  );
}

/** The Archive tab: each archived thread the plugin recorded, newest first, with why it went and what its children did. */
function Archive({ view, error }: { view: ArchiveView | null; error: string | null }) {
  return (
    <>
      <div className="text-sm text-muted-foreground">
        {view === null ? "Loading…" : view.total > view.rows.length ? `The newest ${view.rows.length} of ${view.total} archived threads.` : `${view.total} archived threads.`}
      </div>
      {view === null || coverageText(view) === null ? null : <div className="text-xs text-muted-foreground">{coverageText(view)}</div>}
      {error === null ? null : <Notice tone="error">Could not read the archive: {error}</Notice>}
      {view !== null && view.rows.length === 0 ? <Notice>No archived threads recorded yet. Each archive from now on gets a row.</Notice> : null}
      {view === null || view.rows.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {["Thread", "Started (or created) / archived", "Why", "What happened", "Tokens (approximate: context size when archived; children by phase)"].map((title) => (
                  <th key={title} scope="col" className="px-2 py-1.5 font-medium">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <ArchiveRow key={row.record.threadId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The SGC page: the last check and its trouble on top, then a tab per list. */
function SgcPage({ subPath }: { subPath: string }) {
  const { rpc, snapshot, setSnapshot, loadError, load } = useQuestions();
  const navigate = useBbNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);
  const tab = tabOf(subPath);
  const hosts = useHosts(tab === "hosts");
  const threads = useThreads(tab === "threads");
  const threadsNow = useNow(10_000);
  const archive = useArchive(tab === "archive");
  const [chosen, setChosen] = useState<string[]>([]);
  const [match, setMatch] = useState<LabelMatch>("any");
  const [order, setOrder] = useState<CardOrder>("age");
  const [dismissed, dismiss] = useDismissed();
  const expiredShown = snapshot === null ? [] : snapshot.expired.filter((ask) => !dismissed.includes(ask.id));
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
          badges={{ ...(snapshot === null ? {} : tabBadges({ ...snapshot, expired: expiredShown })), hosts: hostsBadge(hosts.view), threads: threadsBadge(threads.data?.view ?? null) }}
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
        <TabPanel tab="paused" active={tab}>
          {snapshot === null ? null : (
            <Paused
              paused={snapshot.paused}
              expired={expiredShown}
              pausedError={snapshot.pausedError}
              known={snapshot.configured && snapshot.error === null}
              onChanged={load}
              onDismiss={dismiss}
            />
          )}
          {snapshot === null ? null : (
            <Undelivered title="Messages to the steward that did not go out" undelivered={sendsFor("paused", snapshot.undelivered)} unposted={[]} />
          )}
        </TabPanel>
        <TabPanel tab="hosts" active={tab}>
          <Hosts view={hosts.view} error={hosts.error} onRefresh={hosts.load} now={now} />
        </TabPanel>
        <TabPanel tab="threads" active={tab}>
          <Threads data={threads.data} error={threads.error} onRefresh={() => threads.load(true)} onChanged={() => threads.load()} now={threadsNow} />
        </TabPanel>
        <TabPanel tab="archive" active={tab}>
          <Archive view={archive.view} error={archive.error} />
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
