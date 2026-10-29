import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_TABS,
  announcement,
  askAnswerInput,
  filterCards,
  labelChoices,
  noticeTab,
  orderCards,
  questionAnswerInput,
  questionBadge,
  sendsFor,
  sortCards,
  tabBadges,
  tabOf,
  tabPath,
  withDone,
  type Card,
} from "./panel.ts";
import { composeAnswer, parseQuestionBlock, type QuestionBlock } from "./questions.ts";

function block(id: string, body: string, createdAt: string): QuestionBlock {
  const parsed = parseQuestionBlock({ id, body, createdAt, author: "user", parentId: null }, "checkin");
  assert.ok(parsed);
  return parsed;
}

const parsed = block(
  "q1",
  ["[agent:claude-code thr_test1] Questions 2026-01-05", "Q1. Scale?", "- A (recommended): Powers of two.", "- B: Sizes.", "Q2. Anything else?"].join("\n"),
  "2026-01-05T10:00:00.000Z",
);
const raw = block("q2", "[agent:codex thr_test2] Questions 2026-01-06\nfree form", "2026-01-06T09:30:00.000Z");

test("one card's answer names its block, its revision, and its one question", () => {
  assert.equal(questionAnswerInput("uuid-1", parsed, 2, { option: null, text: "  " }), null, "nothing picked or typed");
  assert.deepEqual(questionAnswerInput("uuid-1", parsed, 1, { option: "B", text: "" }), {
    issueId: "uuid-1",
    blocks: [{ blockId: "q1", revision: parsed.revision, answers: [{ number: 1, option: "B", text: "" }] }],
  });
  assert.deepEqual(questionAnswerInput("uuid-1", raw, null, { option: null, text: "Yes." }), {
    issueId: "uuid-1",
    blocks: [{ blockId: "q2", revision: raw.revision, answers: [], text: "Yes." }],
  });
  const typed = questionAnswerInput("uuid-1", parsed, 2, { option: null, text: "Ship Friday." });
  assert.ok(typed);
  assert.equal(
    composeAnswer([parsed], typed.blocks),
    `Answer to the questions of 2026-01-05 (block q1 rev ${parsed.revision}), Q2\n\nQ2.\n> Ship Friday.`,
    "the server names the question, and the block stays open for Q1",
  );
});

test("one new question names its issue or its thread; several are summed up in one notification", () => {
  const note = { id: "q1", source: "linear" as const, label: "TEAM-1", questionCount: 3, preview: "Scale?" };
  assert.deepEqual(announcement([note]), { title: "Steward question on TEAM-1", body: "Scale? (+2 more)" });
  assert.deepEqual(announcement([{ ...note, questionCount: 1 }]), { title: "Steward question on TEAM-1", body: "Scale?" });
  const asked = { id: "bbq_1", source: "ask" as const, label: "Driver: test project", questionCount: 1, preview: "Ship it?" };
  assert.deepEqual(announcement([asked]), { title: "Question from Driver: test project", body: "Ship it?" });
  assert.deepEqual(announcement([note, asked]), {
    title: "2 new questions",
    body: "TEAM-1: Scale?\nDriver: test project: Ship it?",
  });
  const todo = { id: "uuid-TEAM-9", source: "todo" as const, label: "TEAM-9", questionCount: 1, preview: "Log in on the build box" };
  assert.deepEqual(announcement([todo]), { title: "New todo: TEAM-9", body: "Log in on the build box" }, "a todo does not read as a question");
  assert.deepEqual(announcement([todo, { ...todo, id: "uuid-TEAM-10", label: "TEAM-10" }]).title, "2 new todos");
  assert.deepEqual(announcement([note, asked, todo]), {
    title: "2 new questions and 1 new todo",
    body: "TEAM-1: Scale?\nDriver: test project: Ship it?\nTEAM-9: Log in on the build box",
  });
});

test("every open question is its own card, beside raw blocks and bb questions, oldest first", () => {
  const issues = [
    { id: "i2", blocks: [raw] },
    { id: "i1", blocks: [parsed, raw] },
  ];
  const asks = [
    { id: "bbq_late", askedAt: Date.parse("2026-01-07T00:00:00Z") },
    { id: "bbq_early", askedAt: Date.parse("2026-01-04T00:00:00Z") },
  ];
  const name = (card: ReturnType<typeof orderCards<(typeof issues)[number], (typeof asks)[number]>>[number]) =>
    card.kind === "question" ? `${card.issue.id}:${card.block.commentId}:Q${card.question.number}` : card.kind === "raw" ? `${card.issue.id}:${card.block.commentId}` : card.ask.id;
  assert.deepEqual(orderCards(issues, asks).map(name), ["bbq_early", "i1:q1:Q1", "i1:q1:Q2", "i2:q2", "i1:q2", "bbq_late"]);
});

test("a bb question's answer is a picked option, typed text, or both", () => {
  assert.equal(askAnswerInput("bbq_1", { option: null, text: "  " }), null);
  assert.deepEqual(askAnswerInput("bbq_1", { option: "B", text: "" }), { id: "bbq_1", option: "B", text: "" });
  assert.deepEqual(askAnswerInput("bbq_1", { option: null, text: "Later." }), { id: "bbq_1", option: null, text: "Later." });
});

test("the badge counts open questions, then flags answers that did not go out, then Linear trouble", () => {
  const base = { configured: true, error: null, issues: [], asks: [], undelivered: [], unposted: [] };
  assert.equal(questionBadge(base), null);
  assert.deepEqual(questionBadge({ ...base, issues: [{ blocks: [parsed, raw] }], asks: [{}] }), { count: 4, tone: "warning", label: "4 open questions" });
  assert.deepEqual(questionBadge({ ...base, asks: [{}] }), { count: 1, tone: "warning", label: "1 open question" });
  assert.deepEqual(questionBadge({ ...base, undelivered: [{}], unposted: [{}] }), { tone: "critical", label: "2 answers did not go out" });
  assert.deepEqual(questionBadge({ ...base, configured: false }), { tone: "critical", label: "SGC Steward needs a Linear API key" });
  assert.deepEqual(questionBadge({ ...base, error: "boom" }), { tone: "critical", label: "SGC Steward cannot read Linear" });
});

test("a new Done of an issue replaces the page's Undo for its earlier Done", () => {
  const first = { issueId: "uuid-1", undo: "t-1" };
  const other = { issueId: "uuid-2", undo: "t-2" };
  const newer = { issueId: "uuid-1", undo: "t-3" };
  assert.deepEqual(withDone(withDone(withDone([], first), other), newer), [other, newer]);
});

test("each tab has its own route, and a route the page does not know shows Questions", () => {
  assert.deepEqual(PANEL_TABS.map((tab) => tab.id), ["questions", "todos"]);
  assert.equal(tabOf(""), "questions");
  assert.equal(tabOf("todos"), "todos");
  assert.equal(tabOf("todos/extra"), "todos");
  assert.equal(tabOf("ideas"), "questions");
  for (const tab of PANEL_TABS) assert.equal(tabOf(tabPath(tab.id)), tab.id);
});

test("a notification of new todos only opens Todos; one with any question opens Questions", () => {
  assert.equal(noticeTab([{ source: "todo" }, { source: "todo" }]), "todos");
  assert.equal(noticeTab([{ source: "todo" }, { source: "ask" }]), "questions");
  assert.equal(noticeTab([{ source: "linear" }]), "questions");
  assert.equal(noticeTab([]), "questions");
});

test("the steward's todo messages are listed on Todos, every other send on Questions", () => {
  const rows = [{ source: "ask" }, { source: "todo" }, { source: "linear" }, { source: "withdrawal" }] as const;
  assert.deepEqual(sendsFor("questions", rows).map((row) => row.source), ["ask", "linear", "withdrawal"]);
  assert.deepEqual(sendsFor("todos", rows).map((row) => row.source), ["todo"]);
});

test("each tab's badge counts what is open on it, and flags a failure there", () => {
  const base = { issues: [], asks: [], issueErrors: [], undelivered: [], unposted: [], todos: [], todoError: null };
  const quiet = { count: 0, alert: false };
  assert.deepEqual(tabBadges(base), { questions: quiet, todos: quiet });
  assert.deepEqual(tabBadges({ ...base, issues: [{ blocks: [parsed, raw] }], asks: [{}], todos: [{}, {}] }), {
    questions: { count: 4, alert: false },
    todos: { count: 2, alert: false },
  });
  assert.deepEqual(tabBadges({ ...base, undelivered: [{ source: "todo" }] }), { questions: quiet, todos: { count: 0, alert: true } });
  assert.deepEqual(tabBadges({ ...base, todoError: "label filter" }).todos, { count: 0, alert: true });
  assert.deepEqual(tabBadges({ ...base, undelivered: [{ source: "linear" }] }), { questions: { count: 0, alert: true }, todos: quiet });
  assert.deepEqual(tabBadges({ ...base, unposted: [{}] }).questions, { count: 0, alert: true });
  assert.deepEqual(tabBadges({ ...base, issueErrors: [{}] }).questions, { count: 0, alert: true });
});

/** A card's name in the order tests: a bb question's id, or a Linear question as issue:block:Qn. */
function cardName(card: Card<{ id: string }, { id: string }>): string {
  return card.kind === "ask" ? card.ask.id : card.kind === "question" ? `${card.issue.id}:${card.block.commentId}:Q${card.question.number}` : card.issue.id;
}

test("with all of, the page shows the questions that have every label chosen, in any case", () => {
  const asks = [
    { id: "a1", askedAt: 1, labels: ["release", "Infra"] },
    { id: "a2", askedAt: 2, labels: ["release"] },
    { id: "a3", askedAt: 3, labels: [] },
  ];
  const cards = orderCards([{ id: "i1", labels: [], blocks: [parsed] }], asks);
  assert.deepEqual(filterCards(cards, [], "all").map(cardName), cards.map(cardName), "no label chosen shows every card");
  assert.deepEqual(filterCards(cards, ["RELEASE"], "all").map(cardName), ["a1", "a2"]);
  assert.deepEqual(filterCards(cards, ["release", "infra"], "all").map(cardName), ["a1"]);
  assert.deepEqual(filterCards(cards, ["nope"], "all").map(cardName), []);
});

test("sorting by label puts each card under its first label, alphabetically, and cards without one last", () => {
  const asks = [
    { id: "a1", askedAt: 1, labels: ["zeta"] },
    { id: "a2", askedAt: 2, labels: ["zeta", "Alpha"] },
    { id: "a3", askedAt: 3, labels: [] },
    { id: "a4", askedAt: 4, labels: ["alpha"] },
  ];
  const cards = orderCards([{ id: "i1", labels: [], blocks: [parsed] }], asks);
  assert.deepEqual(sortCards(cards, "age").map(cardName), cards.map(cardName), "oldest first is the order the page had");
  assert.deepEqual(sortCards(cards, "label").map(cardName), ["a2", "a4", "a1", "a3", "i1:q1:Q1", "i1:q1:Q2"]);
});

test("the label chips list every label once, and keep a chosen one after its last question is answered", () => {
  assert.deepEqual(labelChoices([{ labels: ["zeta", "Alpha"] }, { labels: ["alpha", "beta"] }], []), ["Alpha", "beta", "zeta"]);
  assert.deepEqual(labelChoices([{ labels: ["beta"] }], ["Gone"]), ["beta", "Gone"]);
  assert.deepEqual(labelChoices([], []), []);
});

test("a Linear question carries its issue's labels, so one label filter covers both kinds", () => {
  const issues = [
    { id: "i1", labels: ["checkin", "area/gdl"], blocks: [parsed] },
    { id: "i2", labels: ["checkin"], blocks: [raw] },
  ];
  const asks = [
    { id: "a1", askedAt: 1, labels: ["area/gdl"] },
    { id: "a2", askedAt: 2, labels: [] },
  ];
  const cards = orderCards(issues, asks);
  assert.deepEqual(filterCards(cards, ["area/gdl"]).map(cardName), ["a1", "i1:q1:Q1", "i1:q1:Q2"]);
  assert.deepEqual(labelChoices([...issues, ...asks], []), ["area/gdl", "checkin"]);
});

test("the page matches any of the labels chosen unless told all of, as Linear's label filter starts", () => {
  const asks = [
    { id: "a1", askedAt: 1, labels: ["release", "Infra"] },
    { id: "a2", askedAt: 2, labels: ["release"] },
    { id: "a3", askedAt: 3, labels: ["infra"] },
    { id: "a4", askedAt: 4, labels: [] },
  ];
  const cards = orderCards([{ id: "i1", labels: ["infra"], blocks: [raw] }], asks);
  assert.deepEqual(filterCards(cards, ["RELEASE", "infra"]).map(cardName), ["a1", "a2", "a3", "i1"], "any of, by default");
  assert.deepEqual(filterCards(cards, ["release", "infra"], "any").map(cardName), ["a1", "a2", "a3", "i1"]);
  assert.deepEqual(filterCards(cards, ["release", "infra"], "all").map(cardName), ["a1"]);
  assert.deepEqual(filterCards(cards, [], "any").map(cardName), cards.map(cardName), "no label chosen shows every card");
});
