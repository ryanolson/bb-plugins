import { test } from "node:test";
import assert from "node:assert/strict";
import { composeArchive, parentText, phaseOf, phaseTokensText, rollupText, startedText, whyText, type ArchiveChildView, type ArchiveRecord } from "./archive-view.ts";

function record(id: string, extra: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    threadId: id,
    title: id,
    parentThreadId: null,
    provider: "claude-code",
    model: null,
    startedAt: 1,
    startedFrom: "created",
    archivedAt: 10,
    source: "lifecycle",
    state: "done",
    reason: "TEAM-1 is Done",
    issue: { identifier: "TEAM-1", url: null, stateName: "Done" },
    usedTokens: null,
    archiveCount: 1,
    ...extra,
  };
}

function child(phase: ArchiveChildView["phase"], usedTokens: number | null, name = "opus"): ArchiveChildView {
  return { threadId: `thr_${name}`, title: name, name, phase, fate: "", usedTokens };
}

test("a child's phase comes from the first role word in its title; a title with none is other", () => {
  assert.equal(phaseOf("1844: plan the archive tab"), "plan");
  assert.equal(phaseOf("1844 planner"), "plan");
  assert.equal(phaseOf("coder: archive tab"), "impl");
  assert.equal(phaseOf("1844: impl round 3"), "impl");
  assert.equal(phaseOf("1844: review impl round 2"), "review");
  assert.equal(phaseOf("reviewer for 1844"), "review");
  // Only the first word counts.
  assert.equal(phaseOf("review the plan"), "review");
  assert.equal(phaseOf("plan the review"), "plan");
  // A word inside another word is not a role.
  assert.equal(phaseOf("explanation of the airplane"), "other");
  assert.equal(phaseOf("fix the flaky test"), "other");
  // A role word after the first word names no role.
  assert.equal(phaseOf("1844: fix review links"), "other");
  // Words Object.prototype has are not roles.
  assert.equal(phaseOf("1844: constructor cleanup"), "other");
  assert.equal(phaseOf("toString review"), "other");
  assert.equal(phaseOf("TEAM-1844: planner for the cut"), "plan");
  assert.equal(phaseOf("1844 coder"), "impl");
});

test("phase tokens: a phase with no usage shows -, never 0, and a partly known phase shows +?", () => {
  assert.equal(phaseTokensText([child("plan", 41_000), child("impl", 200_000), child("impl", 10_000), child("review", 66_000)]), "plan 41k, impl 210k, review 66k");
  assert.equal(phaseTokensText([child("review", null), child("review", null)]), "review -");
  assert.equal(phaseTokensText([child("impl", 5_000), child("impl", null)]), "impl 5k+?");
  assert.equal(phaseTokensText([child("other", 900)]), "other 900");
});

test("the roll-up names who did each phase, counts impl rounds, and ends with the issue", () => {
  const children = [child("plan", 1, "fable"), ...["a", "b", "c", "d"].map((name) => child("impl", 1, name)), ...["e", "f", "g"].map((name) => child("review", 1, name)), child("other", 1, "h")];
  assert.equal(rollupText(record("thr_d"), children), "planned with fable; 4 rounds of impl (a, b, c, d); reviews by e, f, g; other: h. TEAM-1 Done.");
  assert.equal(rollupText(record("thr_d", { issue: null }), [child("impl", 1)]), "1 round of impl (opus). No issue recorded.");
});

test("why it was archived: the lifecycle's reason, an outside archive's last sighting, and a repeat", () => {
  assert.equal(whyText(record("thr_a", { state: "parked", reason: "TEAM-9 is paused in the backlog" })), "Archived by the lifecycle as parked: TEAM-9 is paused in the backlog.");
  assert.equal(whyText(record("thr_a", { source: "outside", state: null, reason: "" })), "Archived outside the plugin; the lifecycle never saw it.");
  assert.equal(whyText(record("thr_a", { source: "outside", state: "idle-active", reason: "TEAM-1 is In Progress", archiveCount: 2 })), "Archived outside the plugin (archived 2 times); last seen idle-active: TEAM-1 is In Progress.");
});

test("compose: newest first, every recorded thread below a driver, and where each parent is", () => {
  const records = [
    record("thr_drv", { archivedAt: 50, title: "drv" }),
    record("thr_coder", { parentThreadId: "thr_drv", title: "coder", archivedAt: 40, startedAt: 2, model: "codex", usedTokens: 1000 }),
    // A grandchild: the coder's own reviewer still counts toward the driver.
    record("thr_rev", { parentThreadId: "thr_coder", title: "review it", archivedAt: 30, startedAt: 3, model: "fable", usedTokens: 2000 }),
    record("thr_kid", { parentThreadId: "thr_open", title: "plan", archivedAt: 20 }),
    record("thr_lost", { parentThreadId: "thr_gone", title: "plan", archivedAt: 60 }),
  ];
  const view = composeArchive(["thr_rev", "thr_drv", "thr_kid", "thr_lost", "thr_coder"], records, new Map([["thr_open", "open driver"]]), 5, null);
  assert.deepEqual(view.rows.map((row) => row.record.threadId), ["thr_lost", "thr_drv", "thr_coder", "thr_rev", "thr_kid"]);
  const driver = view.rows[1]!;
  assert.deepEqual(driver.children.map((entry) => [entry.threadId, entry.phase, entry.name]), [["thr_coder", "impl", "codex"], ["thr_rev", "review", "fable"]]);
  assert.equal(driver.phaseTokens, "impl 1k, review 2k");
  assert.equal(parentText(view.rows[2]!.parent), "Child of drv.");
  assert.equal(parentText(view.rows[4]!.parent), "Child of open driver, which is still open.");
  assert.equal(parentText(view.rows[0]!.parent), "Parent thr_gone is missing: it has no archive record and was not open at the last check.");
  assert.equal(view.total, 5);
});

test("compose survives a parent loop in recorded rows", () => {
  const records = [record("thr_a", { parentThreadId: "thr_b" }), record("thr_b", { parentThreadId: "thr_a" })];
  const view = composeArchive(["thr_a", "thr_b"], records, new Map(), 2, null);
  assert.deepEqual(view.rows.map((row) => row.children.map((entry) => entry.threadId)), [["thr_b"], ["thr_a"]]);
});

test("the start reads started, created, or created with a + when the start was not found", () => {
  const at = (time: number) => `t${time}`;
  assert.equal(startedText({ startedAt: 5, startedFrom: "first-turn" }, at), "started t5");
  assert.equal(startedText({ startedAt: 5, startedFrom: "created" }, at), "created t5");
  assert.equal(startedText({ startedAt: 5, startedFrom: "unknown" }, at), "created t5+ (start not found: the first 2,000 turn starts read were all inherited from its source)");
  assert.equal(startedText({ startedAt: null, startedFrom: "created" }, at), "started ?");
});

test("a row whose start is not known says it was created, not started, before recording began", () => {
  const view = composeArchive(
    ["thr_unknown", "thr_ran"],
    [record("thr_unknown", { startedAt: 1, startedFrom: "unknown" }), record("thr_ran", { startedAt: 1, startedFrom: "first-turn" })],
    new Map(),
    2,
    5,
  );
  const note = (id: string) => view.rows.find((row) => row.record.threadId === id)!.note;
  assert.equal(note("thr_unknown"), "Created before recording began: children archived before then are not counted.");
  assert.equal(note("thr_ran"), "Started before recording began: children archived before then are not counted.");
});
