import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { STORE_MIGRATIONS, createAskStore } from "./ask-store.ts";
import { ASK_TTL_MS, URGENT_TTL_MS, expiryFollowUps, expiryNotice, expiryRecord, type Ask } from "./asks.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-11-20T10:00:00Z");

function open(clock: { at: number }) {
  const db = new Database(":memory:");
  STORE_MIGRATIONS.forEach((statement) => db.exec(statement));
  return { db, store: createAskStore(db, () => clock.at) };
}

function ask(id: string, extra: Partial<Ask> = {}): Ask {
  return {
    id,
    threadId: "thr_a",
    threadTitle: "Thread A",
    question: `Question ${id}?`,
    options: [{ letter: "A", text: "Yes.", recommended: true }],
    issue: null,
    labels: ["Project"],
    askedAt: START,
    ...extra,
  };
}

const followUps = (row: Ask, tell = true) => expiryFollowUps(row, row.askedAt + ASK_TTL_MS, tell);

test("an ask lives 3 days, or 1 day when urgent", () => {
  assert.equal(ASK_TTL_MS, 3 * DAY);
  assert.equal(URGENT_TTL_MS, DAY);
});

test("a question expires at its boundary and not before", () => {
  const clock = { at: START };
  const { store } = open(clock);
  store.admit(ask("bbq_1"), false, START + 3 * DAY);
  assert.deepEqual(store.due(START + 3 * DAY - 1), []);
  assert.deepEqual(store.due(START + 3 * DAY).map((row) => row.id), ["bbq_1"]);
  clock.at = START + 3 * DAY - 1;
  assert.equal(store.expire("bbq_1", followUps(ask("bbq_1"))), "not_due");
  assert.equal(store.get("bbq_1")!.state, "open");
  clock.at = START + 3 * DAY;
  assert.equal(store.expire("bbq_1", followUps(ask("bbq_1"))), "expired");
  const row = store.get("bbq_1")!;
  assert.deepEqual([row.state, row.expiredAt], ["expired", START + 3 * DAY]);
});

test("an answer that lands first wins, and an expired question takes no answer or withdrawal", () => {
  const clock = { at: START };
  const { store } = open(clock);
  store.admit(ask("bbq_1"), false, START + DAY);
  store.admit(ask("bbq_2", { question: "Other?" }), false, START + DAY);
  clock.at = START + DAY;
  assert.equal(store.answer("bbq_1", { option: "A", text: "" }, "bb", { message: "m", label: "bbq_1" }, null), "answered");
  assert.equal(store.expire("bbq_1", followUps(ask("bbq_1"))), "not_open", "answered first: expiry saves nothing");
  assert.equal(store.deliveryFor("expiry", "bbq_1", "thr_a"), null);
  assert.equal(store.expire("bbq_2", followUps(ask("bbq_2"))), "expired");
  assert.equal(store.answer("bbq_2", { option: "A", text: "" }, "bb", { message: "m", label: "bbq_2" }, null), "not_open", "expired first: the answer fails");
  assert.equal(store.withdraw("bbq_2", { thread: "thr_a", by: "thr_a", steward: false, reason: null, notice: null, record: null }), "not_open");
  assert.equal(store.deliveryFor("ask", "bbq_2", "thr_a"), null);
});

test("an expiry keeps one notice and one record, and a second expiry adds none", () => {
  const clock = { at: START + 3 * DAY };
  const { store } = open(clock);
  const row = ask("bbq_1", { issue: "TEAM-12" });
  store.admit(row, false, START + 3 * DAY);
  assert.equal(store.expire("bbq_1", followUps(row)), "expired");
  assert.equal(store.expire("bbq_1", followUps(row)), "not_open");
  const delivery = store.deliveryFor("expiry", "bbq_1", "thr_a")!;
  assert.equal(delivery.state, "pending");
  assert.match(delivery.message, /^\[sgc-steward\] Expired bbq_1\n/);
  assert.equal(store.undelivered().length, 1);
  assert.equal(store.unposted().length, 1);
  assert.equal(store.record("bbq_1")!.issue, "TEAM-12");
  const quiet = ask("bbq_2", { question: "No issue?" });
  store.admit(quiet, false, START);
  store.expire("bbq_2", expiryFollowUps(quiet, START + 3 * DAY, false));
  assert.equal(store.deliveryFor("expiry", "bbq_2", "thr_a"), null, "a gone thread is not told");
  assert.equal(store.record("bbq_2"), null, "no issue, no record");
});

test("a question stored before has no clock; its first poll gives it a fresh 3 days", () => {
  const clock = { at: START };
  const { store } = open(clock);
  store.admit(ask("bbq_1"), false);
  assert.equal(store.get("bbq_1")!.expiresAt, null);
  assert.deepEqual(store.due(START + 30 * DAY), [], "null never expires");
  clock.at = START + 10 * DAY;
  store.startExpiryClocks(ASK_TTL_MS);
  assert.equal(store.get("bbq_1")!.expiresAt, START + 13 * DAY);
  clock.at = START + 11 * DAY;
  store.startExpiryClocks(ASK_TTL_MS);
  assert.equal(store.get("bbq_1")!.expiresAt, START + 13 * DAY, "a set clock is not moved");
});

test("expired questions of the last 14 days are listed, newest first", () => {
  const clock = { at: START };
  const { store } = open(clock);
  for (const [id, expiredAt] of [["bbq_old", START - 15 * DAY], ["bbq_a", START - 2 * DAY], ["bbq_b", START - DAY]] as const) {
    store.admit(ask(id, { question: id }), false, expiredAt);
    clock.at = expiredAt;
    store.expire(id, followUps(ask(id)));
  }
  clock.at = START;
  assert.deepEqual(store.listExpired(START - 14 * DAY).map((row) => row.id), ["bbq_b", "bbq_a"]);
});

test("the notice tells the thread to save and pause, and the record names the expiry", () => {
  const row = ask("bbq_1", { issue: "TEAM-12" });
  const at = Date.parse("2026-11-23T10:00:00Z");
  const notice = expiryNotice(row, at);
  assert.match(notice, /^\[sgc-steward\] Expired bbq_1\n/);
  assert.match(notice, /No answer came by 2026-11-23 10:00 UTC/);
  assert.match(notice, /commit, push, and check that the remote branch matches HEAD/);
  assert.match(notice, /paused: no answer by 2026-11-23/);
  assert.match(notice, /Backlog with the `paused` label/);
  assert.match(notice, /If you are the steward thread, do not archive/);
  assert.ok(notice.includes("Question bbq_1?"));
  const record = expiryRecord(row, at);
  assert.match(record, /expired/);
  assert.ok(record.includes("Question bbq_1?"));
  assert.equal(expiryFollowUps(row, at, true).record!.issue, "TEAM-12");
  assert.equal(expiryFollowUps(row, at, false).notice, null);
});
