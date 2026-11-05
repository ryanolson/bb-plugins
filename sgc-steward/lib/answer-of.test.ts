// What `bb sgc answer-of` reports of a stored bb question: the store keeps
// where each answer came from, and the view prints only stored state.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { STORE_MIGRATIONS, createAskStore } from "./ask-store.ts";
import type { Ask } from "./asks.ts";
import { defineCli } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { answerOf, answerOfCommand } from "./answer-of.ts";

const ASKED = Date.parse("2026-01-05T10:00:00Z");
const ANSWERED = Date.parse("2026-01-05T11:30:00Z");

function migrate(db: Database.Database, statements: readonly string[]) {
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (const statement of statements.slice(applied)) db.exec(statement);
  db.pragma(`user_version = ${statements.length}`);
}

function open() {
  const db = new Database(":memory:");
  migrate(db, STORE_MIGRATIONS);
  return { db, store: createAskStore(db, () => ANSWERED) };
}

function ask(id: string, extra: Partial<Ask> = {}): Ask {
  return {
    id,
    threadId: "thr_asker",
    threadTitle: "Asker",
    question: "Merge !42 at head abc123 onto def456?",
    options: [
      { letter: "A", text: "Approve", recommended: true },
      { letter: "B", text: "Reject", recommended: false },
    ],
    issue: "TEAM-7",
    labels: [],
    askedAt: ASKED,
    ...extra,
  };
}

const delivery = { message: "m", label: "x" };

test("an answered question reports the chosen option's letter and text, the asking thread, and where the answer came from", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), true);
  assert.equal(store.answer("bbq_1", { option: "A", text: "" }, "bb", delivery, null), "answered");
  assert.deepEqual(answerOf(store.get("bbq_1")!), {
    id: "bbq_1",
    threadId: "thr_asker",
    issue: "TEAM-7",
    question: "Merge !42 at head abc123 onto def456?",
    options: [
      { letter: "A", text: "Approve" },
      { letter: "B", text: "Reject" },
    ],
    status: "answered",
    answeredAt: "2026-01-05T11:30:00.000Z",
    channel: "bb",
    option: { letter: "A", text: "Approve" },
    text: null,
  });
});

test("the channel is the path the store was given: bb for the page, linear for one taken from a comment", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), true);
  store.admit(ask("bbq_2", { question: "Another?" }), true);
  store.answer("bbq_1", { option: "B", text: "" }, "bb", delivery, null);
  store.answer("bbq_2", { option: "A", text: "" }, "linear", delivery, null);
  assert.equal(answerOf(store.get("bbq_1")!).channel, "bb");
  assert.equal(answerOf(store.get("bbq_2")!).channel, "linear");
});

test("a free-text answer has no option, and a note under an option is its text", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), true);
  store.admit(ask("bbq_2", { question: "Another?" }), true);
  store.answer("bbq_1", { option: null, text: "  Wait for the soak.  " }, "bb", delivery, null);
  store.answer("bbq_2", { option: "B", text: "Rebase first." }, "bb", delivery, null);
  const free = answerOf(store.get("bbq_1")!);
  assert.deepEqual([free.option, free.text], [null, "Wait for the soak."]);
  const noted = answerOf(store.get("bbq_2")!);
  assert.deepEqual([noted.option, noted.text], [{ letter: "B", text: "Reject" }, "Rebase first."]);
});

test("an open or withdrawn question is not answered: no time, channel, option, or text", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), true);
  store.admit(ask("bbq_2", { question: "Another?" }), true);
  store.withdraw("bbq_2", { thread: "thr_asker", by: "thr_asker", steward: false, reason: null, notice: null, record: null });
  for (const [id, status] of [["bbq_1", "open"], ["bbq_2", "withdrawn"]] as const) {
    const view = answerOf(store.get(id)!);
    assert.deepEqual([view.status, view.answeredAt, view.channel, view.option, view.text], [status, null, null, null, null], id);
  }
});

test("an answer stored before the channel was kept reports no channel, so a check that needs bb refuses it", () => {
  const db = new Database(":memory:");
  migrate(db, STORE_MIGRATIONS.slice(0, 10));
  db.prepare(
    `INSERT INTO asks (id, thread_id, thread_title, question, options, issue, asked_at, state, answer, answered_at)
     VALUES ('bbq_old', 'thr_a', 'A', 'Old?', '[{"letter":"A","text":"Approve","recommended":false}]', NULL, 1, 'answered', '{"option":"A","text":""}', 2)`,
  ).run();
  migrate(db, STORE_MIGRATIONS);
  const view = answerOf(createAskStore(db).get("bbq_old")!);
  assert.deepEqual([view.status, view.channel, view.option], ["answered", null, { letter: "A", text: "Approve" }]);
});

test("a stored answer naming an option its question lacks is refused as corrupt, not printed as a free-text answer", async (t) => {
  const { db, store } = open();
  store.admit(ask("bbq_1", { options: [{ letter: "A", text: "Approve", recommended: true }] }), true);
  db.prepare(`UPDATE asks SET state = 'answered', answer = '{"option":"B","text":""}', answered_at = 1, answer_channel = 'bb' WHERE id = 'bbq_1'`).run();
  assert.throws(() => answerOf(store.get("bbq_1")!), /option B, which it does not have/);
  const { bb, harness } = createFakePluginHost({ pluginId: "sgc-steward" });
  t.after(() => harness.lifecycle.dispose());
  bb.cli.register(defineCli({ name: "sgc", summary: "Read stored answers", commands: { "answer-of": answerOfCommand(store) } }));
  const json = await harness.behavior.runCli(["answer-of", "bbq_1", "--json"]);
  assert.equal(json.exitCode, 1);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, error: { code: "corrupt", message: "bbq_1 has an answer for option B, which it does not have" } });
  const text = await harness.behavior.runCli(["answer-of", "bbq_1"]);
  assert.equal(text.exitCode, 1);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /option B, which it does not have/);
});
