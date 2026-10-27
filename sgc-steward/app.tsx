// SGC Steward frontend: the Questions page, its sidebar badge, and the
// notifier that tells you, once per question or todo, that new ones came. The
// page holds two kinds of question, Linear blocks and bb questions agents
// asked with `bb sgc ask`, and your todos from Linear.
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
  answerProgress,
  askAnswerInput,
  EMPTY_DRAFT,
  orderCards,
  questionBadge,
  toAnswerBlocks,
  withDone,
  type AskDraft,
  type BlockDraft,
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

function ParsedBlock({
  block,
  draft,
  onChange,
}: {
  block: Extract<QuestionBlock, { format: "parsed" }>;
  draft: BlockDraft;
  onChange: (next: BlockDraft) => void;
}) {
  return (
    <div className="space-y-4">
      <BlockHeader block={block} />
      {block.context === "" ? null : <Markdown content={block.context} className="text-sm text-muted-foreground" />}
      {block.questions.map((question) => {
        const picked = draft.options[question.number];
        const text = draft.texts[question.number] ?? "";
        const name = `${block.commentId}-q${question.number}`;
        return (
          <fieldset key={question.number} className="space-y-2">
            <legend className="flex w-full items-start gap-2 text-sm font-medium">
              <span className="shrink-0">Q{question.number}.</span>
              <Markdown content={question.text} className="min-w-0 flex-1" />
            </legend>
            {question.options.length === 0 ? null : (
              <div className="space-y-1.5 pl-6">
                {question.options.map((option) => (
                  <label
                    key={option.letter}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
                      picked === option.letter ? "border-foreground/50 bg-state-active" : "border-border hover:bg-state-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      className="mt-0.5"
                      checked={picked === option.letter}
                      onChange={() => onChange({ ...draft, options: { ...draft.options, [question.number]: option.letter } })}
                    />
                    <span className="font-mono">{option.letter}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
                    {option.recommended ? (
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">Recommended</span>
                    ) : null}
                  </label>
                ))}
                {picked === undefined ? null : (
                  <button
                    type="button"
                    className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => {
                      const options = { ...draft.options };
                      delete options[question.number];
                      onChange({ ...draft, options });
                    }}
                  >
                    Clear choice
                  </button>
                )}
              </div>
            )}
            <div className="pl-6">
              <textarea
                className={textareaClass()}
                value={text}
                aria-label={`Answer to Q${question.number}`}
                placeholder={
                  question.options.length === 0 ? "Type your answer" : picked === undefined ? "Or type your own answer" : "Add a note (optional)"
                }
                onChange={(event) => onChange({ ...draft, texts: { ...draft.texts, [question.number]: event.target.value } })}
              />
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function RawBlock({
  block,
  draft,
  onChange,
}: {
  block: Extract<QuestionBlock, { format: "raw" }>;
  draft: BlockDraft;
  onChange: (next: BlockDraft) => void;
}) {
  return (
    <div className="space-y-2">
      <BlockHeader block={block} />
      <p className="text-xs text-muted-foreground">Not in the question format ({block.problem}), so it is shown as written.</p>
      <div className="rounded-md bg-secondary/40 px-3 py-2">
        <Markdown content={block.body} className="text-sm" />
      </div>
      <textarea
        className={textareaClass()}
        value={draft.raw}
        aria-label="Answer"
        placeholder="Type your answer"
        onChange={(event) => onChange({ ...draft, raw: event.target.value })}
      />
    </div>
  );
}

function IssueCard({ issue, onAnswered }: { issue: IssueView; onAnswered: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [drafts, setDrafts] = useState<Record<string, BlockDraft>>({});
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { answered, total } = answerProgress(issue.blocks, drafts);

  async function submit() {
    setPosting(true);
    setError(null);
    try {
      const result = await rpc.call("questions.answer", { issueId: issue.id, blocks: toAnswerBlocks(issue.blocks, drafts) });
      toast.success(`Posted the answer to ${result.identifier}`, result.warning === null ? {} : { description: result.warning });
      onAnswered();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <UrlLink href={issue.url} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
          {issue.identifier}
        </UrlLink>
        <h2 className="min-w-0 flex-1 text-sm font-medium">{issue.title}</h2>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
          {issue.kind === "checkin" ? "check-in" : "needs decision"}
        </span>
      </header>
      {issue.blocks.map((block) => {
        const draft = drafts[block.commentId] ?? EMPTY_DRAFT;
        // The first edit pins the revision the answers are written against.
        const onChange = (next: BlockDraft) =>
          setDrafts((current) => ({ ...current, [block.commentId]: { ...next, revision: current[block.commentId]?.revision ?? block.revision } }));
        return block.format === "parsed" ? (
          <ParsedBlock key={block.commentId} block={block} draft={draft} onChange={onChange} />
        ) : (
          <RawBlock key={block.commentId} block={block} draft={draft} onChange={onChange} />
        );
      })}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3">
        <Button disabled={posting || answered === 0} onClick={() => void submit()}>
          {posting ? "Posting…" : "Post answer to Linear"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {answered} of {total} answered.
          {issue.blocks.length > 1 ? " One comment answers every block above." : ""}
          {answered > 0 && answered < total ? " The rest are posted as “No answer.”" : ""}
          {issue.kind === "needs-decision" ? " Posting also removes the needs-decision label when no newer question is open." : ""}
        </span>
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
        {ask.issue === null ? null : <span className="text-xs text-muted-foreground">issue {ask.issue}</span>}
      </header>
      <Markdown content={ask.question} className="text-sm" />
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
              <input
                type="radio"
                name={ask.id}
                className="mt-0.5"
                checked={draft.option === option.letter}
                onChange={() => setDraft({ ...draft, option: option.letter })}
              />
              <span className="font-mono">{option.letter}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
              {option.recommended ? (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">Recommended</span>
              ) : null}
            </label>
          ))}
          {draft.option === null ? null : (
            <button
              type="button"
              className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setDraft({ ...draft, option: null })}
            >
              Clear choice
            </button>
          )}
        </div>
      )}
      <textarea
        className={textareaClass()}
        value={draft.text}
        aria-label={`Answer to ${ask.id}`}
        placeholder={options.length === 0 ? "Type your answer" : draft.option === null ? "Or type your own answer" : "Add a note (optional)"}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
      />
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
function Undelivered({ undelivered, unposted }: { undelivered: DeliveryView[]; unposted: RecordView[] }) {
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

  return (
    <section className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm">
      <h2 className="font-medium">Answers that did not go out</h2>
      <p className="text-xs text-muted-foreground">A send that looked failed may still have arrived, so a retry can deliver an answer twice.</p>
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

/** Your todos, and the ones done from this page, which can be undone while the page stays open. */
function Todos({ todos, todoError }: { todos: TodoView[]; todoError: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [doneHere, setDoneHere] = useState<DoneHere[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  if (todos.length === 0 && doneHere.length === 0 && todoError === null) return null;

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
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Todos</h2>
      {todoError === null ? null : <Notice tone="error">Could not read the todos: {todoError}</Notice>}
      {todos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No todos.</p>
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

function QuestionsPage() {
  const { rpc, snapshot, setSnapshot, loadError, load } = useQuestions();
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);

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
            {snapshot.issues.length > 0 ? " The questions below are from the last good check." : ""}
          </Notice>
        ) : null}
        {snapshot?.issueErrors.map((failed) => (
          <Notice key={failed.identifier} tone="error">
            Could not read {failed.identifier}: {failed.message}
          </Notice>
        ))}
        {snapshot === null ? null : <Todos todos={snapshot.todos} todoError={snapshot.todoError} />}
        {snapshot === null ? null : <Undelivered undelivered={snapshot.undelivered} unposted={snapshot.unposted} />}
        {snapshot !== null && snapshot.asks.length === 0 && snapshot.configured && snapshot.issues.length === 0 && snapshot.error === null ? (
          <Notice>No open questions.</Notice>
        ) : null}
        {snapshot === null
          ? null
          : orderCards(snapshot.issues, snapshot.asks).map((card) =>
              card.kind === "issue" ? (
                <IssueCard
                  key={`${card.issue.id}:${card.issue.blocks.map((block) => `${block.commentId}@${block.revision}`).join(",")}`}
                  issue={card.issue}
                  onAnswered={load}
                />
              ) : (
                <AskCard key={card.ask.id} ask={card.ask} onAnswered={load} />
              ),
            )}
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
        if (notifications.length > 0) announce(notifications, () => navigate.toPluginPanel(PANEL_PATH));
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
    component: QuestionsPage,
    experimental_useBadge: useQuestionsBadge,
  });
  app.slots.experimental_appOverlay({ id: "notifier", component: Notifier });
});
