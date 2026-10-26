// SGC Steward frontend: the Questions page, its sidebar badge, and the
// notifier that tells you, once per question block, that new questions came.
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
import type { IssueView, QuestionNotification, Snapshot, rpcContract } from "./server.ts";
import type { QuestionBlock } from "./lib/questions.ts";
import { announcement, answerProgress, EMPTY_DRAFT, toAnswerBlocks, type BlockDraft } from "./lib/panel.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHANNEL = "questions";
const PANEL_PATH = "questions";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The last poll's questions, refetched whenever the server says they changed. */
function useQuestions() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
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

function questionCount(snapshot: Snapshot): number {
  return snapshot.issues.reduce(
    (sum, issue) => sum + issue.blocks.reduce((count, block) => count + (block.format === "parsed" ? block.questions.length : 1), 0),
    0,
  );
}

function useQuestionsBadge(): ExperimentalBadge | null {
  const { snapshot } = useQuestions();
  if (snapshot === null) return null;
  const count = questionCount(snapshot);
  if (count > 0) return { count, tone: "warning", label: `${count} open steward question${count === 1 ? "" : "s"}` };
  if (!snapshot.configured) return { tone: "critical", label: "SGC Steward needs a Linear API key" };
  if (snapshot.error !== null) return { tone: "critical", label: "SGC Steward cannot read Linear" };
  return null;
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
        {snapshot !== null && snapshot.configured && snapshot.issues.length === 0 && snapshot.error === null ? (
          <Notice>No open questions.</Notice>
        ) : null}
        {snapshot?.issues.map((issue) => (
          <IssueCard
            key={`${issue.id}:${issue.blocks.map((block) => `${block.commentId}@${block.revision}`).join(",")}`}
            issue={issue}
            onAnswered={load}
          />
        ))}
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
      const notification = new Notification(title, { body, tag: `sgc-steward-${notes[0]!.blockId}` });
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
  toast(title, { description: body, action: { label: "Answer", onClick: open } });
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
