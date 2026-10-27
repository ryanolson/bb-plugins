import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { STORE_MIGRATIONS, createAskId, createAskStore } from "./ask-store.ts";
import type { Ask } from "./asks.ts";

let clock = Date.parse("2026-01-05T10:00:00Z");
const now = () => (clock += 1000);

/** Apply the statements not applied yet, as bb.storage.migrate does: shipped statements run once. */
function migrate(db: Database.Database, statements: readonly string[]) {
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (const statement of statements.slice(applied)) db.exec(statement);
  db.pragma(`user_version = ${statements.length}`);
}

function open(path = ":memory:") {
  const db = new Database(path);
  migrate(db, STORE_MIGRATIONS);
  return { db, store: createAskStore(db, now) };
}

function ask(id: string, extra: Partial<Ask> = {}): Ask {
  return {
    id,
    threadId: "thr_a",
    threadTitle: "Thread A",
    question: `Question ${id}?`,
    options: [
      { letter: "A", text: "Yes.", recommended: true },
      { letter: "B", text: "No.", recommended: false },
    ],
    issue: null,
    askedAt: now(),
    ...extra,
  };
}

/** A thread withdrawing its own question: no reason needed, nobody to tell. */
function own(thread: string) {
  return { thread, by: thread, steward: false, reason: null, notice: null, record: null };
}

test("the shipped migration statements never change, because the host refuses a changed one", () => {
  const hash = (statement: string) => createHash("sha256").update(statement).digest("hex").slice(0, 16);
  const shipped = ["201efed5e3e033d1", "00e4f9328a580a32", "b6975aa10840e9c7", "3d3eefa6d3eb3097", "8bf1acf89069b93d", "3e5eaeeb41357d9c"];
  assert.deepEqual(STORE_MIGRATIONS.slice(0, shipped.length).map(hash), shipped);
});

test("a database from before the withdrawal columns upgrades, and its questions can be withdrawn", () => {
  const db = new Database(":memory:");
  migrate(db, STORE_MIGRATIONS.slice(0, 3));
  db.prepare(
    `INSERT INTO asks (id, thread_id, thread_title, question, options, issue, asked_at, state, notified_at)
     VALUES ('bbq_old', 'thr_a', 'Thread A', 'Old?', '[]', NULL, 1, 'open', NULL)`,
  ).run();
  migrate(db, STORE_MIGRATIONS);
  const store = createAskStore(db, now);
  const before = store.get("bbq_old")!;
  assert.deepEqual([before.state, before.withdrawnBy, before.withdrawReason, before.withdrawnAt], ["open", null, null, null]);
  assert.equal(store.withdraw("bbq_old", { ...own("thr_s"), steward: true, reason: "Stale." }), "withdrawn");
  const after = store.get("bbq_old")!;
  assert.deepEqual([after.state, after.withdrawnBy, after.withdrawReason], ["withdrawn", "thr_s", "Stale."]);
});

test("ids look like bbq_ and differ", () => {
  const ids = new Set(Array.from({ length: 50 }, () => createAskId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^bbq_[a-z0-9]{10}$/);
});

test("open questions list oldest first", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), false);
  store.admit(ask("bbq_2", { threadId: "thr_b" }), false);
  store.admit(ask("bbq_3"), false);
  assert.deepEqual(store.listOpen().map((row) => row.id), ["bbq_1", "bbq_2", "bbq_3"]);
  assert.deepEqual(store.get("bbq_2")?.options.map((option) => option.letter), ["A", "B"]);
  assert.equal(store.get("bbq_9"), null);
});

test("the same open question from the same thread is stored once", () => {
  const { store } = open();
  const first = ask("bbq_1", { issue: "TEAM-1" });
  assert.deepEqual(store.admit(first, false), { kind: "asked", id: "bbq_1" });
  assert.deepEqual(store.admit({ ...first, id: "bbq_2" }, false), { kind: "existing", id: "bbq_1" });
  assert.equal(store.admit({ ...first, id: "bbq_3", threadId: "thr_b" }, false).kind, "asked");
  assert.equal(store.admit({ ...first, id: "bbq_4", issue: null }, false).kind, "asked");
  assert.equal(store.admit({ ...first, id: "bbq_5", options: first.options.slice(0, 1) }, false).kind, "asked");
});

test("a full cap refuses a new question, but a repeat still gets its id", () => {
  const { store } = open();
  for (let n = 1; n <= 10; n += 1) store.admit(ask(`bbq_a${n}`), false);
  assert.deepEqual(store.admit(ask("bbq_a11"), false), { kind: "full", scope: "thread", open: 10 });
  assert.deepEqual(store.admit({ ...ask("bbq_x"), question: "Question bbq_a3?" }, false), { kind: "existing", id: "bbq_a3" });
  for (let n = 11; n <= 50; n += 1) store.admit(ask(`bbq_b${n}`, { threadId: `thr_${Math.floor(n / 10)}` }), false);
  assert.deepEqual(store.admit(ask("bbq_c", { threadId: "thr_new" }), false), { kind: "full", scope: "total", open: 50 });
});

test("only the asking thread withdraws, and only an open question", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), false);
  assert.equal(store.withdraw("bbq_1", own("thr_b")), "not_yours");
  assert.equal(store.withdraw("bbq_9", own("thr_a")), "not_found");
  assert.equal(store.withdraw("bbq_1", own("thr_a")), "withdrawn");
  assert.equal(store.withdraw("bbq_1", own("thr_a")), "not_open");
  const row = store.get("bbq_1")!;
  assert.deepEqual([row.withdrawnBy, row.withdrawReason], ["thr_a", null]);
  assert.equal(store.deliveryFor("withdrawal", "bbq_1", "thr_a"), null, "a thread that withdraws its own question is not told");
  assert.deepEqual(store.listOpen(), []);
  assert.equal(store.answer("bbq_1", { option: "A", text: "" }, { message: "m", label: "bbq_1" }, null), "not_open");
});

test("an answer is saved once, with its delivery and its record, in one step", () => {
  const { store } = open();
  store.admit(ask("bbq_1", { issue: "TEAM-1" }), false);
  assert.equal(store.answer("bbq_1", { option: "B", text: "Wait." }, { message: "delivered text", label: "bbq_1" }, { issue: "TEAM-1", body: "record" }), "answered");
  const row = store.get("bbq_1")!;
  assert.equal(row.state, "answered");
  assert.deepEqual(row.answer, { option: "B", text: "Wait." });
  const delivery = store.deliveryFor("ask", "bbq_1", "thr_a")!;
  assert.equal(delivery.state, "pending");
  assert.equal(delivery.message, "delivered text");
  assert.deepEqual(store.record("bbq_1"), { askId: "bbq_1", issue: "TEAM-1", body: "record", state: "pending", commentId: null, error: null, attempts: 0 });
  assert.equal(store.answer("bbq_1", { option: "A", text: "" }, { message: "again", label: "bbq_1" }, null), "not_open");
  assert.equal(store.deliveryFor("ask", "bbq_1", "thr_a")!.message, "delivered text", "a second answer changes nothing");
  assert.equal(store.answer("bbq_9", { option: "A", text: "" }, { message: "m", label: "x" }, null), "not_found");
});

const ANSWER = { ref: "c-1", issueId: "uuid-1", label: "TEAM-1", message: "one" };

test("a held delivery is released once, and only to the first caller", () => {
  const { store } = open();
  store.hold(ANSWER, ["thr_a", "thr_b"]);
  const [first] = store.held();
  assert.deepEqual(first, { ref: "c-1", issueId: "uuid-1", label: "TEAM-1", heldAt: store.deliveryFor("linear", "c-1", "thr_a")!.createdAt });
  store.hold({ ...ANSWER, message: "two" }, ["thr_a"]);
  assert.ok(store.held()[0]!.heldAt > first!.heldAt, "a new post restarts the post window");
  assert.deepEqual(store.undelivered(), [], "held deliveries are not listed");
  const released = store.release("c-1");
  assert.deepEqual(released.map((row) => [row.threadId, row.state, row.message]), [["thr_a", "pending", "one"], ["thr_b", "pending", "one"]]);
  assert.deepEqual(store.release("c-1"), [], "a second release hands out nothing");
  assert.deepEqual(store.held(), []);
  store.hold(ANSWER, ["thr_a"]);
  assert.equal(store.deliveryFor("linear", "c-1", "thr_a")!.state, "pending", "holding again leaves a released delivery as it is");
});

test("dropping an answer forgets only its held deliveries", () => {
  const { store } = open();
  store.hold(ANSWER, ["thr_a"]);
  store.hold({ ...ANSWER, ref: "c-2" }, ["thr_a"]);
  store.release("c-2");
  store.drop("c-1");
  store.drop("c-2");
  assert.equal(store.deliveryFor("linear", "c-1", "thr_a"), null);
  assert.equal(store.deliveryFor("linear", "c-2", "thr_a")!.state, "pending");
});

test("a delivery is kept once per source, reference, and thread, and records its attempts", () => {
  const { store } = open();
  store.hold(ANSWER, ["thr_a"]);
  const [first] = store.release("c-1");
  store.markDelivery(first!.id, { ok: false, error: "thread not found" });
  assert.deepEqual(
    store.undelivered().map((row) => [row.id, row.state, row.error, row.attempts]),
    [[first!.id, "failed", "thread not found", 1]],
  );
  store.markDelivery(first!.id, { ok: true });
  const delivered = store.getDelivery(first!.id)!;
  assert.deepEqual([delivered.state, delivered.error, delivered.attempts], ["delivered", null, 2]);
  assert.ok(delivered.deliveredAt !== null);
  assert.deepEqual(store.undelivered(), []);
});

test("records that did not post are listed until they do", () => {
  const { store } = open();
  store.admit(ask("bbq_1", { issue: "TEAM-1" }), false);
  store.answer("bbq_1", { option: "A", text: "" }, { message: "m", label: "bbq_1" }, { issue: "TEAM-1", body: "record" });
  store.markRecord("bbq_1", { ok: false, error: "no key" });
  assert.deepEqual(store.unposted().map((row) => [row.askId, row.state, row.error, row.attempts]), [["bbq_1", "failed", "no key", 1]]);
  store.markRecord("bbq_1", { ok: true, commentId: "c-9" });
  assert.deepEqual(store.unposted(), []);
  assert.equal(store.record("bbq_1")?.commentId, "c-9");
});

test("each open question is handed out for a notification once", () => {
  const { store } = open();
  store.admit(ask("bbq_1"), false);
  store.admit(ask("bbq_2"), true);
  store.admit(ask("bbq_3"), false);
  store.withdraw("bbq_3", own("thr_a"));
  assert.deepEqual(store.claim().map((row) => row.id), ["bbq_1"]);
  assert.deepEqual(store.claim(), []);
});

test("questions and their deliveries survive closing and reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "sgc-asks-"));
  try {
    const path = join(dir, "data.db");
    const first = open(path);
    first.store.admit(ask("bbq_1"), false);
    first.store.hold(ANSWER, ["thr_a"]);
    first.store.hold({ ...ANSWER, ref: "c-2" }, ["thr_a"]);
    first.store.release("c-2");
    first.db.close();
    const second = open(path);
    assert.deepEqual(second.store.listOpen().map((row) => row.id), ["bbq_1"]);
    assert.deepEqual(second.store.held().map((row) => row.ref), ["c-1"]);
    assert.deepEqual(second.store.undelivered().map((row) => row.ref), ["c-2"]);
    second.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the steward withdraws any open question, and its notice and record are saved with the withdrawal", () => {
  const { store } = open();
  store.admit(ask("bbq_1", { issue: "TEAM-1" }), false);
  const steward = { thread: "thr_s", by: "thr_s", steward: true, reason: "Decided elsewhere.", notice: "told", record: { issue: "TEAM-1", body: "recorded" } };
  assert.equal(store.withdraw("bbq_1", steward), "withdrawn");
  const row = store.get("bbq_1")!;
  assert.deepEqual([row.state, row.withdrawnBy, row.withdrawReason], ["withdrawn", "thr_s", "Decided elsewhere."]);
  assert.ok(row.withdrawnAt !== null);
  const notice = store.deliveryFor("withdrawal", "bbq_1", "thr_a")!;
  assert.deepEqual([notice.state, notice.label, notice.message], ["pending", "Withdrawal of bbq_1", "told"]);
  assert.deepEqual([store.record("bbq_1")?.issue, store.record("bbq_1")?.body], ["TEAM-1", "recorded"]);
  assert.equal(store.withdraw("bbq_1", steward), "not_open", "a second withdrawal changes nothing");
  assert.equal(store.answer("bbq_1", { option: "A", text: "" }, { message: "m", label: "bbq_1" }, null), "not_open");
});

test("a database with the six shipped steps upgrades: its questions stay, and the todo table works", () => {
  const db = new Database(":memory:");
  migrate(db, STORE_MIGRATIONS.slice(0, 6));
  const before = createAskStore(db, now);
  before.admit(ask("bbq_live"), false);
  migrate(db, STORE_MIGRATIONS);
  const after = createAskStore(db, now);
  assert.deepEqual(after.listOpen().map((row) => row.id), ["bbq_live"]);
  db.prepare("INSERT INTO seen_todos (issue_id, identifier, title, first_seen_at, notified_at) VALUES ('uuid-1', 'TEAM-1', 'Log in', 1, NULL)").run();
  assert.deepEqual(db.prepare("SELECT identifier FROM seen_todos").all(), [{ identifier: "TEAM-1" }]);
});

test("a kept message goes to the call that kept it; the same message kept again is not handed out", () => {
  const { store } = open();
  const kept = store.keep({ source: "todo", ref: "c-1", threadId: "thr_s", label: "Todo done TEAM-1", message: "done" });
  assert.deepEqual([kept?.state, kept?.label, kept?.message], ["pending", "Todo done TEAM-1", "done"]);
  assert.equal(store.keep({ source: "todo", ref: "c-1", threadId: "thr_s", label: "Todo done TEAM-1", message: "done" }), null);
  assert.deepEqual(store.undelivered().map((row) => row.ref), ["c-1"]);
});
