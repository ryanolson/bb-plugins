import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { STORE_MIGRATIONS, createAskStore, type Delivery } from "./ask-store.ts";
import { createTodos, type TodoDeps } from "../todos.ts";
import { FakeLinear } from "../test-support.ts";

const pending = { todo: process.env.SGC_REVIEW_ENFORCE !== "1" && "P2 F2: finishing an action and releasing its message are not atomic" };

test("todo review P2 F2: interruption before message release remains recoverable", pending, async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  for (const sql of STORE_MIGRATIONS) db.exec(sql);
  const asks = createAskStore(db);
  const linear = new FakeLinear();
  const issue = linear.addIssue("TEAM-1", ["waiting:ryan-action"]);
  const sent: Delivery[] = [];
  const deps: TodoDeps = {
    db,
    postWindowMs: 600_000,
    write: (work) => work(linear, "TEAM"),
    steward: async () => "thr_steward",
    hold: (ref, issueId, label, message, threadId) => asks.hold({ ref, issueId, label, message }, [threadId], "todo"),
    release: (ref) => asks.release(ref, "todo"),
    drop: (ref) => asks.drop(ref, "todo"),
    send: async (row) => { sent.push(row); return "sent"; },
    sendAfterPoll: (rows) => sent.push(...rows),
    forget: () => {},
    publish: () => {},
    refresh: async () => {},
    configured: () => true,
    log: () => {},
  };
  const first = createTodos({
    ...deps,
    release: () => { throw new Error("stopped before releasing the held message"); },
  });
  await first.rpc["todos.done"]({ issue: issue.id, note: "" }).catch(() => undefined);
  assert.equal(issue.comments.length, 1, "the comment is on Linear");
  assert.deepEqual(issue.labels, [], "the change is on Linear");
  assert.equal(sent.length, 0, "no send started before the interruption");

  const replacement = createTodos(deps);
  await replacement.poll(linear, "TEAM", true, new AbortController().signal);
  assert.equal(sent.length + asks.undelivered().filter((row) => row.source === "todo").length, 1,
    "an interruption between finishing and releasing must not strand a held delivery forever");
});
