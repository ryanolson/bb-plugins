import assert from "node:assert/strict";
import { test } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { HOUR, MIN, THREAD_A, setup } from "./test-support.ts";

test("thread loss after reload cannot restart an expired lease's deletion grace", async () => {
  const world = await setup();
  try {
    await world.tick();
    const { id, ns, result } = await world.lease(THREAD_A, "review-p5-overdue-thread", 4, { hours: 1 });
    assert.equal(result.code, 0);
    world.cluster.setDgd(ns, "worker", 4);
    const expiresAt = Date.parse(result.json.expires_at);
    world.clock.advance(2 * HOUR + MIN);
    await world.reload();
    world.threads.fates.set(THREAD_A, "archived");
    await world.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD_A, archivedAt: world.clock.now() } as never),
    });
    const shown = await world.cli(["lease", "show", id]);
    assert.equal(shown.json.state, "revoking");
    assert.equal(world.cluster.inspect(ns).dgd_gpus, 0, "thread loss already reached the guard");
    assert.equal(
      Date.parse(shown.json.grace_deadline),
      expiresAt + HOUR,
      "threadGone ran before the first expiry sweep and postponed an overdue deletion by 3660 seconds",
    );
    assert.equal(ns.deleting, true, "the original grace deadline passed before the plugin reloaded");
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
