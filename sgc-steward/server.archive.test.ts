import { test } from "node:test";
import assert from "node:assert/strict";
import { MINUTE } from "./lib/lifecycle.ts";
import type { ArchiveRowView, ArchiveView } from "./lib/archive-view.ts";
import { START, lifecycleSetup } from "./test-support-threads.ts";

const ACT = { threadLifecycleMode: "act", stewardThread: "thr_steward" };

const rowOf = (view: ArchiveView, id: string): ArchiveRowView => {
  const found = view.rows.find((row) => row.record.threadId === id);
  assert.ok(found, `no archive row for ${id}`);
  return found;
};

const archiveSignals = (t: Awaited<ReturnType<typeof lifecycleSetup>>) => t.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "archive").length;

test("a driver's row rolls up three children of different fates, from the rows already recorded", async () => {
  const t = await lifecycleSetup(
    [
      { id: "thr_drv", title: "1: archive tab", model: "opus", tokens: 80_000, createdAt: START - 3 * 60 * MINUTE },
      // No issue in its title: the lifecycle never archives it, so the driver archives it itself.
      { id: "thr_plan", title: "plan the archive tab", parentThreadId: "thr_drv", model: "fable", tokens: 41_000 },
      { id: "thr_impl", title: "1: impl round 1", parentThreadId: "thr_drv", model: "codex", tokens: 210_000 },
    ],
    { settings: ACT },
  );
  t.issue("TEAM-1", "state-done");

  // Pass one: the lifecycle archives the implementer; the driver waits for its live children.
  await t.pass();
  assert.deepEqual(t.acted, ["archive thr_impl"]);
  assert.equal(archiveSignals(t), 1, "the page hears of the row at once");

  // The driver archives its planner: bb's event is the only word of it.
  t.state.archived.add("thr_plan");
  await t.emitArchived("thr_plan", START + MINUTE);
  // A reviewer spawned and archived between passes: the lifecycle never saw it.
  t.state.threads.push({ id: "thr_rev", title: "review impl round 1", parentThreadId: "thr_drv", tokens: 66_000 });
  t.state.archived.add("thr_rev");
  await t.emitArchived("thr_rev", START + 2 * MINUTE);

  // Pass two: no live child is left, so the driver goes too.
  t.clock.now += 5 * MINUTE;
  await t.pass();
  assert.deepEqual(t.acted, ["archive thr_impl", "archive thr_drv"]);

  const sdkCalls = t.sdk.calls.length;
  const linearCalls = t.linear.calls.length;
  const view = await t.archive();
  assert.equal(t.sdk.calls.length, sdkCalls, "opening the tab reads nothing from bb");
  assert.equal(t.linear.calls.length, linearCalls, "opening the tab reads nothing from Linear");

  assert.deepEqual(
    view.rows.map((row) => row.record.threadId),
    ["thr_drv", "thr_rev", "thr_plan", "thr_impl"],
    "newest archive first",
  );
  assert.equal(view.total, 4);

  const driver = rowOf(view, "thr_drv");
  assert.equal(driver.why, "Archived by the lifecycle as done: TEAM-1 is Done.");
  assert.equal(driver.summary, "Planned with fable; 1 round of impl (codex); review by claude-code. TEAM-1 Done.");
  assert.equal(driver.tokens, "80k");
  assert.equal(driver.phaseTokens, "plan 41k, impl 210k, review 66k");
  assert.equal(driver.record.startedAt, START - 3 * 60 * MINUTE);
  assert.equal(driver.record.archivedAt, START + 5 * MINUTE);
  assert.equal(driver.parent, null);
  assert.deepEqual(
    driver.children.map((child) => [child.threadId, child.phase, child.fate]),
    [
      ["thr_impl", "impl", "TEAM-1 Done; archived by the lifecycle"],
      ["thr_plan", "plan", "no issue recorded; archived outside the plugin"],
      ["thr_rev", "review", "no issue recorded; archived outside the plugin"],
    ],
  );

  const impl = rowOf(view, "thr_impl");
  assert.equal(impl.summary, "TEAM-1 Done; archived by the lifecycle.");
  assert.deepEqual(impl.parent, { threadId: "thr_drv", status: "archived", title: "1: archive tab" });
  assert.equal(impl.phaseTokens, null);

  // The planner was in the last snapshot: its model, tokens and state come from there.
  const plan = rowOf(view, "thr_plan");
  assert.equal(plan.why, "Archived outside the plugin; last seen idle-active: no issue yet.");
  assert.deepEqual([plan.record.model, plan.record.usedTokens, plan.record.source], ["fable", 41_000, "outside"]);

  // The reviewer was not: one context read gave its tokens, and its provider names it.
  const review = rowOf(view, "thr_rev");
  assert.equal(review.why, "Archived outside the plugin; the lifecycle never saw it.");
  assert.deepEqual([review.record.model, review.record.usedTokens], [null, 66_000]);
});

test("a lone worker shows its own fate, and its row survives a restart", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix", tokens: 20_000 }]);
  t.issue("TEAM-3", "state-done");
  await t.list();
  await t.act("thr_solo", "archive");
  const view = await t.archive();
  const solo = rowOf(view, "thr_solo");
  assert.equal(solo.why, "Archived from the page (Archive now) as done: TEAM-3 is Done.");
  assert.equal(solo.summary, "TEAM-3 Done; archived from the page (Archive now).");
  assert.deepEqual([solo.children, solo.phaseTokens, solo.tokens, solo.parent], [[], null, "20k", null]);

  const reloaded = await t.harness.lifecycle.reload(t.factory);
  const after = (await reloaded.harness.behavior.callRpc("archive.list", null)) as ArchiveView;
  assert.deepEqual(after, view);
});

test("an unarchive takes the row off the tab, and each re-archive updates the same row", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  await t.act("thr_solo", "archive");
  assert.equal(rowOf(await t.archive(), "thr_solo").record.archiveCount, 1);

  await t.emitUnarchived("thr_solo");
  t.state.archived.delete("thr_solo");
  assert.deepEqual(await t.archive(), { rows: [], total: 0, recordedSince: START });

  // Archived again from the page: the same row, counted twice.
  t.clock.now += 60 * MINUTE;
  await t.act("thr_solo", "archive");
  let view = await t.archive();
  assert.equal(view.total, 1);
  assert.deepEqual([rowOf(view, "thr_solo").record.archiveCount, rowOf(view, "thr_solo").record.archivedAt], [2, START + 60 * MINUTE]);
  assert.match(rowOf(view, "thr_solo").why, /archived 2 times/);

  // Unarchived and archived once more, this time by someone else.
  await t.emitUnarchived("thr_solo");
  await t.emitArchived("thr_solo", START + 120 * MINUTE);
  view = await t.archive();
  assert.equal(view.total, 1);
  const row = rowOf(view, "thr_solo");
  assert.deepEqual([row.record.archiveCount, row.record.source, row.record.archivedAt], [3, "outside", START + 120 * MINUTE]);
});

test("bb's archive event for the plugin's own archive never adds a second row or count, whichever lands first", async () => {
  for (const order of ["event first", "event last"] as const) {
    const t = await lifecycleSetup([{ id: "thr_done", title: "1: finished" }], { settings: ACT });
    t.issue("TEAM-1", "state-done");
    // bb sends its event inside the archive call by default. For "event last" it queues it on a setImmediate before it replies, as real bb does, so the reply lands first.
    if (order === "event last") {
      t.state.onArchive = async (id) => {
        const at = t.clock.now;
        setImmediate(() => void t.emitArchived(id, at));
      };
    }
    await t.pass();
    const view = await t.archive();
    assert.equal(view.total, 1, order);
    const row = rowOf(view, "thr_done");
    assert.deepEqual([row.record.source, row.record.archiveCount, row.why], ["lifecycle", 1, "Archived by the lifecycle as done: TEAM-1 is Done."], order);
  }
});

test("a missed unarchive: a later archive event over a current row is a new archive of the same row", async () => {
  const t = await lifecycleSetup([{ id: "thr_x", title: "free work" }]);
  await t.emitArchived("thr_x", START);
  await t.emitArchived("thr_x", START + 30 * MINUTE);
  const view = await t.archive();
  assert.equal(view.total, 1);
  assert.deepEqual([rowOf(view, "thr_x").record.archiveCount, rowOf(view, "thr_x").record.archivedAt], [2, START + 30 * MINUTE]);
});

test("a deleted Linear issue: a row keeps what it recorded, and a later archive records no issue", async () => {
  const t = await lifecycleSetup(
    [
      { id: "thr_gone", title: "4: since deleted" },
      { id: "thr_left", title: "5: left behind", tokens: 20_000 },
    ],
    { settings: ACT },
  );
  const done = t.issue("TEAM-4", "state-done");
  const open = t.issue("TEAM-5", "state-started");
  await t.pass();
  assert.deepEqual(t.acted, ["archive thr_gone"]);
  const before = rowOf(await t.archive(), "thr_gone");

  t.linear.issues = t.linear.issues.filter((candidate) => candidate !== done && candidate !== open);
  t.clock.now += 5 * MINUTE;
  await t.pass();
  // The archived thread's row is never read again: it still names the issue as it was.
  const kept = rowOf(await t.archive(), "thr_gone");
  assert.deepEqual(kept, before);
  assert.deepEqual(kept.record.issue, { identifier: "TEAM-4", url: done.url, stateName: "Done" });
  assert.equal(kept.summary, "TEAM-4 Done; archived by the lifecycle.");

  // The open thread's issue is gone by the time it is archived, so its row records none.
  t.state.archived.add("thr_left");
  await t.emitArchived("thr_left", t.clock.now);
  const left = rowOf(await t.archive(), "thr_left");
  assert.equal(left.record.issue, null);
  assert.equal(left.summary, "No issue recorded; archived outside the plugin.");
  assert.equal(left.why, "Archived outside the plugin; last seen idle-active: no issue yet.");
});

test("a row whose parent has no archive record and is not open says so plainly", async () => {
  const t = await lifecycleSetup([
    { id: "thr_live_parent", title: "5: still driving", status: "active" },
    { id: "thr_kid", title: "impl for a live driver", parentThreadId: "thr_live_parent" },
  ]);
  await t.list();
  await t.emitArchived("thr_kid", START);
  await t.emitArchived("thr_orphan", START + MINUTE, { title: "review for nobody", parentThreadId: "thr_vanished" });
  const view = await t.archive();
  assert.deepEqual(rowOf(view, "thr_kid").parent, { threadId: "thr_live_parent", status: "open", title: "5: still driving" });
  assert.deepEqual(rowOf(view, "thr_orphan").parent, { threadId: "thr_vanished", status: "missing" });
});

test("bb sgc threads archive prints the rows, and says once that tokens are approximate", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix", tokens: 20_000 }]);
  t.issue("TEAM-3", "state-done");
  await t.act("thr_solo", "archive");
  const text = await t.harness.behavior.runCli(["threads", "archive"], { threadId: "thr_steward" });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /thr_solo {2}3: solo fix/);
  assert.match(text.stdout, /why: Archived from the page \(Archive now\) as done: TEAM-3 is Done\./);
  assert.equal(text.stdout.match(/approximate/g)?.length, 1);
  const json = await t.harness.behavior.runCli(["threads", "archive", "--json", "--limit", "1"], { threadId: "thr_steward" });
  assert.equal((JSON.parse(json.stdout) as ArchiveView).rows.length, 1);
  const bad = await t.harness.behavior.runCli(["threads", "archive", "--limit", "0"], { threadId: "thr_steward" });
  assert.notEqual(bad.exitCode, 0);
});

// --- overlaps: bb dispatches its events without waiting for a handler, and the plugin's archive reply can come back at any point among them.

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await turn();
  }
  assert.fail(`never: ${what}`);
}

/** Archive now, with bb's reply held after bb archived the thread and sent its event. */
async function heldArchiveNow(t: Awaited<ReturnType<typeof lifecycleSetup>>, id: string) {
  const hold = gate();
  t.state.onArchive = async (threadId) => {
    await t.emitArchived(threadId, t.clock.now);
    await hold.promise;
  };
  const acting = t.act(id, "archive");
  await until(async () => (await t.archive()).total > 0, "the event's row");
  return { release: hold.release, acting };
}

test("overlap: a held context read cannot bring back a row that an unarchive took off", async () => {
  // Never listed, so the snapshot does not hold it and its archive reads its usage.
  const t = await lifecycleSetup([{ id: "thr_new", title: "1844: impl later", tokens: 5_000 }]);
  const hold = gate();
  t.state.contextGate = hold.promise;
  const archiving = t.emitArchived("thr_new", START);
  await turn();
  await t.emitUnarchived("thr_new");
  hold.release();
  await archiving;
  const view = await t.archive();
  assert.deepEqual([view.total, view.rows], [0, []]);
});

test("overlap: a held Archive now reply after an unarchive neither brings the row back nor counts it twice", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  const { release, acting } = await heldArchiveNow(t, "thr_solo");
  await t.emitUnarchived("thr_solo");
  release();
  await acting;
  assert.deepEqual((await t.archive()).total, 0);
  await t.emitArchived("thr_solo", START + 30 * MINUTE);
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.archiveCount, row.record.source], [2, "outside"]);
});

test("overlap: an unarchive and an outside re-archive while Archive now's reply is held: bb's times and count, and a row that says which archive was the plugin's is unknown", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  const { release, acting } = await heldArchiveNow(t, "thr_solo");
  await t.emitUnarchived("thr_solo");
  await t.emitArchived("thr_solo", START + 10 * MINUTE);
  release();
  await acting;
  const view = await t.archive();
  assert.equal(view.total, 1);
  const row = rowOf(view, "thr_solo");
  // The plugin sees the same as when the outside archive and undo come before its own: bb does not say which archive was the plugin's.
  assert.deepEqual([row.record.source, row.record.archiveCount, row.record.archivedAt], ["page", 2, START + 10 * MINUTE]);
  assert.match(row.why, /bb does not say which archive was the plugin's/);
});

test("overlap: a reply whose archivedThreadIds leaves the thread out writes none of the plugin's reasons", async () => {
  // Someone else archived it just before the plugin asked, or just after: either way bb's reply names no thread.
  for (const offset of [-MINUTE, 0]) {
    const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
    t.issue("TEAM-3", "state-done");
    await t.list();
    t.state.archiveReply = () => [];
    t.state.onArchive = (id) => t.emitArchived(id, t.clock.now + offset);
    await t.act("thr_solo", "archive");
    const row = rowOf(await t.archive(), "thr_solo");
    assert.deepEqual([row.record.source, row.record.archivedAt, row.record.archiveCount], ["outside", START + offset, 1], `offset ${offset}`);
    assert.equal(row.why, "Archived outside the plugin; last seen done: TEAM-3 is Done.", `offset ${offset}`);
  }
});

test("overlap: a held reply across another thread's archive keeps bb's archive times and their order", async () => {
  const t = await lifecycleSetup([
    { id: "thr_a", title: "3: first" },
    { id: "thr_b", title: "free work" },
  ]);
  t.issue("TEAM-3", "state-done");
  const { release, acting } = await heldArchiveNow(t, "thr_a");
  t.clock.now += MINUTE;
  t.state.archived.add("thr_b");
  await t.emitArchived("thr_b", t.clock.now);
  t.clock.now += MINUTE;
  release();
  await acting;
  const view = await t.archive();
  assert.deepEqual(view.rows.map((row) => [row.record.threadId, row.record.archivedAt]), [
    ["thr_b", START + MINUTE],
    ["thr_a", START],
  ]);
  assert.equal(rowOf(view, "thr_a").record.source, "page");
});

test("a re-archive with no usage shows -, and its phase shows the known sum with +?", async () => {
  const t = await lifecycleSetup([
    { id: "thr_drv", title: "1844: drive" },
    { id: "thr_c1", title: "1844: impl one", parentThreadId: "thr_drv", tokens: 210_000 },
    { id: "thr_c2", title: "1844: impl two", parentThreadId: "thr_drv", tokens: 5_000 },
  ]);
  await t.emitArchived("thr_c1", START);
  await t.emitArchived("thr_c2", START);
  await t.emitUnarchived("thr_c1");
  t.state.threads[1]!.tokens = null;
  await t.emitArchived("thr_c1", START + 5 * MINUTE);
  await t.emitArchived("thr_drv", START + 6 * MINUTE);
  const view = await t.archive();
  assert.equal(rowOf(view, "thr_c1").tokens, "-");
  assert.equal(rowOf(view, "thr_drv").phaseTokens, "impl 5k+?");
});

test("started is the first turn that started, and the creation time, labeled so, when none did", async () => {
  const t = await lifecycleSetup([
    // Requested at 11:20, while bb provisioned; the turn started at 11:30.
    { id: "thr_ran", title: "ran", brief: "do it", createdAt: START - 2 * 60 * MINUTE, requestedAt: START - 40 * MINUTE, firstTurnAt: START - 30 * MINUTE },
    // Requested, then cancelled before any turn started.
    { id: "thr_cancelled", title: "cancelled", brief: "do it", createdAt: START - 90 * MINUTE, requestedAt: START - 80 * MINUTE },
    { id: "thr_quiet", title: "never ran", createdAt: START - 60 * MINUTE },
  ]);
  for (const id of ["thr_ran", "thr_cancelled", "thr_quiet"]) await t.emitArchived(id, START);
  const view = await t.archive();
  assert.deepEqual([rowOf(view, "thr_ran").record.startedAt, rowOf(view, "thr_ran").record.startedFrom], [START - 30 * MINUTE, "first-turn"]);
  assert.deepEqual([rowOf(view, "thr_cancelled").record.startedAt, rowOf(view, "thr_cancelled").record.startedFrom], [START - 90 * MINUTE, "created"]);
  assert.deepEqual([rowOf(view, "thr_quiet").record.startedAt, rowOf(view, "thr_quiet").record.startedFrom], [START - 60 * MINUTE, "created"]);
});

test("the tab says which archives it covers: those recorded since the first row", async () => {
  const t = await lifecycleSetup([{ id: "thr_x", title: "free work" }]);
  assert.equal((await t.archive()).recordedSince, null);
  await t.emitArchived("thr_x", START);
  assert.equal((await t.archive()).recordedSince, START);
});

test("the same archive announced twice counts once, and an older archive announced late changes nothing", async () => {
  const t = await lifecycleSetup([{ id: "thr_x", title: "free work" }]);
  await t.emitArchived("thr_x", START + 10 * MINUTE);
  await t.emitArchived("thr_x", START + 10 * MINUTE);
  await t.emitArchived("thr_x", START);
  const row = rowOf(await t.archive(), "thr_x");
  assert.deepEqual([row.record.archiveCount, row.record.archivedAt], [1, START + 10 * MINUTE]);
});

test("an archive from before the plugin asked is someone else's, even when the plugin's call then fails", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  await t.list();
  t.state.onArchive = async (id) => {
    await t.emitArchived(id, t.clock.now - MINUTE);
    throw new Error("the reply was lost");
  };
  await assert.rejects(t.act("thr_solo", "archive"));
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.source, row.record.archivedAt], ["outside", START - MINUTE]);
});

test("a child titled with a word Object.prototype has still reads as other, and the tab still opens", async () => {
  const t = await lifecycleSetup([
    { id: "thr_drv", title: "1844: drive" },
    { id: "thr_kid", title: "1844: constructor cleanup", parentThreadId: "thr_drv", tokens: 1_000 },
  ]);
  await t.emitArchived("thr_kid", START);
  await t.emitArchived("thr_drv", START + MINUTE);
  const driver = rowOf(await t.archive(), "thr_drv");
  assert.deepEqual(driver.children.map((child) => child.phase), ["other"]);
  assert.equal(driver.phaseTokens, "other 1k");
});

test("overlap: an outside archive and undo before bb handles Archive now leave the plugin's archive its own reason", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  const hold = gate();
  let reached = false;
  t.state.beforeArchive = async () => {
    reached = true;
    await hold.promise;
  };
  const acting = t.act("thr_solo", "archive");
  await until(async () => reached, "bb's archive call");
  // Someone else archives it and undoes that while the plugin's request waits.
  await t.emitArchived("thr_solo", START + MINUTE);
  await t.emitUnarchived("thr_solo");
  t.clock.now = START + 2 * MINUTE;
  hold.release();
  await acting;
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.source, row.record.archiveCount, row.record.archivedAt], ["page", 2, START + 2 * MINUTE]);
  assert.match(row.why, /bb does not say which archive was the plugin's/);
});

test("overlap: a reply that names no thread puts an unseen thread's row back to the outside facts, usage read included", async () => {
  // Never listed, so the snapshot does not hold it.
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix", tokens: 12_000 }]);
  t.issue("TEAM-3", "state-done");
  t.state.archiveReply = () => [];
  t.state.onArchive = (id) => t.emitArchived(id, t.clock.now);
  await t.act("thr_solo", "archive");
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.source, row.record.model, row.tokens], ["outside", null, "12k"]);
  assert.equal(row.why, "Archived outside the plugin; the lifecycle never saw it.");
});

test("re-archiving a thread does not move the start of what the tab covers", async () => {
  const t = await lifecycleSetup([
    { id: "thr_a", title: "a" },
    { id: "thr_b", title: "b" },
  ]);
  await t.emitArchived("thr_a", START);
  await t.emitArchived("thr_b", START + 10 * MINUTE);
  await t.emitUnarchived("thr_a");
  await t.emitArchived("thr_a", START + 20 * MINUTE);
  assert.equal((await t.archive()).recordedSince, START);
});

test("overlap: the same archive announced twice while the plugin's note is open is still someone else's when the reply names no thread", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  await t.list();
  t.state.archiveReply = () => [];
  t.state.onArchive = async (id) => {
    await t.emitArchived(id, t.clock.now);
    await t.emitArchived(id, t.clock.now);
  };
  await t.act("thr_solo", "archive");
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.source, row.record.archiveCount], ["outside", 1]);
  assert.doesNotMatch(row.why, /does not say/);
});

test("a failed archive call after an archive keeps the plugin's reason and says the archive may be someone else's", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  t.state.onArchive = async (id) => {
    await t.emitArchived(id, t.clock.now);
    throw new Error("the reply was lost");
  };
  await assert.rejects(t.act("thr_solo", "archive"));
  const row = rowOf(await t.archive(), "thr_solo");
  assert.equal(row.record.source, "page");
  assert.match(row.why, /the plugin's archive call failed, so this archive may be someone else's/);
});

test("overlap: the plugin's own archive announced twice is one archive, with no doubt about whose it was", async () => {
  const t = await lifecycleSetup([{ id: "thr_solo", title: "3: solo fix" }]);
  t.issue("TEAM-3", "state-done");
  t.state.onArchive = async (id) => {
    await t.emitArchived(id, t.clock.now);
    await t.emitArchived(id, t.clock.now);
  };
  await t.act("thr_solo", "archive");
  const row = rowOf(await t.archive(), "thr_solo");
  assert.deepEqual([row.record.source, row.record.archiveCount], ["page", 1]);
  assert.doesNotMatch(row.why, /does not say/);
});
