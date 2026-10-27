import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { STORE_MIGRATIONS, createAskStore, type Delivery } from "./ask-store.ts";
import { createTodos, type TodoDeps } from "../todos.ts";
import { FakeLinear } from "../test-support.ts";


test("todo review P2 F2: interruption before message release remains recoverable", async (t) => {
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
    keep: (row) => asks.keep({ source: "todo", ...row }),
    send: async (row) => { sent.push(row); asks.markDelivery(row.id, { ok: true }); return "sent"; },
    forget: () => {},
    publish: () => {},
    refresh: async () => {},
    configured: () => true,
    log: () => {},
  };
  const first = createTodos({
    ...deps,
    keep: () => { throw new Error("stopped before keeping the message"); },
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
