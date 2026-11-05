import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./lib/contract.ts";
import { CLUSTER_A, HOUR, THREAD_A, newUid, setup } from "./test-support.ts";

test("the panel keeps an active lease visible after 500 newer leases have ended", async () => {
  const world = await setup();
  await world.tick();
  const active = await world.lease(THREAD_A, "review-f8-active", 4, { hours: 4 });
  assert.equal(active.result.code, 0);
  world.clock.advance(HOUR);
  await world.tick();

  const db = world.bb.storage.database();
  const insert = db.prepare(`INSERT INTO leases
    (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, 'gb300', 1, 1, 0, ?, ?, 'released', ?)`);
  // Seed finished history without spending the targeted test's time on 500 CLI round trips.
  db.transaction(() => {
    for (let n = 0; n < 500; n += 1) {
      const at = world.clock.now();
      insert.run(`lse_history${String(n).padStart(6, "0")}`, THREAD_A, CLUSTER_A, CLUSTER_A, `review-f8-history-${n}`, newUid(), at, at + HOUR, at);
    }
  })();

  assert.ok((await world.cli(["leases", "--json"])).json.some((row: { lease_id: string }) => row.lease_id === active.id));
  const snapshot = (await world.harness.behavior.callRpc("snapshot", null)) as Snapshot;
  assert.equal(snapshot.capacity.find((row) => row.gpuType === "gb300")?.used, 4);
  assert.ok(snapshot.leases.some((row) => row.id === active.id), "the charged lease and its Extend button disappear from the panel");
});
