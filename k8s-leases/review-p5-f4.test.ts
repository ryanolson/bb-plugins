import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_A, HOST_ONE, THREAD_A, setup } from "./test-support.ts";

test("a settings change between the final settings read and insert cannot authorize capacity removed before commit", async () => {
  const violations: number[] = [];
  let refused = 0;
  let committedBeforeChange = 0;
  for (let depth = 0; depth < 24; depth += 1) {
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    try {
      await world.tick();
      const ns = world.cluster.create(CLUSTER_A, "review-p5-settings-commit", THREAD_A);
      const db = world.bb.storage.database();
      const count = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM leases");
      const handle = world.guard.handle.bind(world.guard);
      let changedBeforeCommit = false;
      let change: Promise<void> | undefined;
      let changeDone!: () => void;
      const changed = new Promise<void>((resolve) => { changeDone = resolve; });
      world.guard.handle = async (method, input, hostId) => {
        const answer = await handle(method, input, hostId);
        if (method === "inspect" && input.namespace === ns.name) {
          const schedule = (left: number): void => {
            if (left > 0) {
              queueMicrotask(() => schedule(left - 1));
              return;
            }
            changedBeforeCommit = count.get()!.count === 0;
            // The fake SDK saves settings and invokes onChange synchronously.
            change = world.harness.behavior.setSettings({ gpuLimits: JSON.stringify({ gb300: 0 }) });
            changeDone();
          };
          schedule(depth);
        }
        return answer;
      };
      const result = await world.acquire(THREAD_A, ns, 4);
      await changed;
      await change;
      if (result.code !== 0) refused += 1;
      else if (changedBeforeCommit) violations.push(depth);
      else committedBeforeChange += 1;
    } finally {
      await world.harness.lifecycle.dispose();
    }
  }
  assert.ok(refused > 0, "the early settings changes refuse the acquire");
  assert.ok(committedBeforeChange > 0, "the late settings changes happen after a valid commit");
  assert.deepEqual(violations, [], "the final async settings read overwrote onChange's newer config and granted four GPUs after the limit became zero");
});
