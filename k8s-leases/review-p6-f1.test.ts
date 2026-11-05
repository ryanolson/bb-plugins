import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_ONE, THREAD_A, setup } from "./test-support.ts";

test("a renewal cannot use a limit removed before its transaction", async () => {
  const violations: number[] = [];
  let refused = 0;
  let committedBeforeChange = 0;
  for (let depth = 0; depth < 24; depth += 1) {
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    try {
      await world.tick();
      const { id, result } = await world.lease(THREAD_A, "review-p6-renew-settings", 4);
      assert.equal(result.code, 0);
      const row = world.bb.storage.database().prepare<[string], { renewals: number }>("SELECT renewals FROM leases WHERE id = ?");
      let changedBeforeCommit = false;
      let change: Promise<void> | undefined;
      let changeDone!: () => void;
      const changed = new Promise<void>((resolve) => { changeDone = resolve; });
      const renewing = world.cli(["lease", "renew", id], THREAD_A);
      const schedule = (left: number): void => {
        if (left > 0) {
          queueMicrotask(() => schedule(left - 1));
          return;
        }
        changedBeforeCommit = row.get(id)!.renewals === 0;
        change = world.harness.behavior.setSettings({ maxRenewals: 0 });
        changeDone();
      };
      queueMicrotask(() => schedule(depth));
      const renewed = await renewing;
      await changed;
      await change;
      if (renewed.code !== 0) {
        assert.equal(renewed.json.code, "renewals_used");
        refused += 1;
      } else if (changedBeforeCommit) violations.push(depth);
      else committedBeforeChange += 1;
    } finally {
      await world.harness.lifecycle.dispose();
    }
  }
  assert.ok(refused > 0, "the early changes refuse the renewal");
  assert.ok(committedBeforeChange > 0, "the late changes follow a valid renewal");
  assert.deepEqual(violations, [], "renew granted time after maxRenewals became zero");
});

test("a panel extension cannot exceed a cap reduced before its transaction", async () => {
  const violations: number[] = [];
  let refused = 0;
  let committedBeforeChange = 0;
  for (let depth = 0; depth < 24; depth += 1) {
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    try {
      await world.tick();
      const { id, result } = await world.lease(THREAD_A, "review-p6-extend-settings", 4);
      assert.equal(result.code, 0);
      const before = Date.parse(result.json.expires_at);
      const row = world.bb.storage.database().prepare<[string], { expires_at: number }>("SELECT expires_at FROM leases WHERE id = ?");
      let changedBeforeCommit = false;
      let change: Promise<void> | undefined;
      let changeDone!: () => void;
      const changed = new Promise<void>((resolve) => { changeDone = resolve; });
      const extending = world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 120 }).then(
        () => true,
        (error: unknown) => {
          assert.match(String(error), /at most 1 h/);
          return false;
        },
      );
      const schedule = (left: number): void => {
        if (left > 0) {
          queueMicrotask(() => schedule(left - 1));
          return;
        }
        changedBeforeCommit = row.get(id)!.expires_at === before;
        change = world.harness.behavior.setSettings({ maxExtendHours: 1 });
        changeDone();
      };
      queueMicrotask(() => schedule(depth));
      const extended = await extending;
      await changed;
      await change;
      if (!extended) refused += 1;
      else if (changedBeforeCommit) violations.push(depth);
      else committedBeforeChange += 1;
    } finally {
      await world.harness.lifecycle.dispose();
    }
  }
  assert.ok(refused > 0, "the early changes refuse the extension");
  assert.ok(committedBeforeChange > 0, "the late changes follow a valid extension");
  assert.deepEqual(violations, [], "Extend added two hours after its cap became one hour");
});
