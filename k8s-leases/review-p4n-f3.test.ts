// The schema's migrations are append-only. A database installed at v1 (one
// statement) migrates to v2 (claims of a pre-made namespace): its live leases
// keep their state and become created-mode leases, and enforcement registers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./lib/store.ts";
import { createK8sLeasesPlugin } from "./server.ts";
import { BASE_SETTINGS, CLUSTER_A, HOUR, T0, THREAD_A, newUid } from "./test-support.ts";

test("a v1 database migrates to v2, keeps its live leases across a reload, and registers enforcement", async () => {
  // Append-only: v1 is the one statement first installed; v2 (claims) comes after it.
  assert.equal(MIGRATIONS.length, 2);
  let loaded = createFakePluginHost({ pluginId: "k8s-leases", settings: BASE_SETTINGS });
  try {
    const db = loaded.bb.storage.database();
    loaded.bb.storage.migrate(db, [MIGRATIONS[0]!]);
    db.prepare(
      `INSERT INTO leases (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'gb300', 4, 1, 0, ?, ?, 'active')`,
    ).run("lse_v1000000001", THREAD_A, CLUSTER_A, CLUSTER_A, "dyntest-v1", newUid(), T0, T0 + HOUR);
    await assert.doesNotReject(async () => {
      loaded = await loaded.harness.lifecycle.reload(createK8sLeasesPlugin({ now: () => T0 }));
    });
    const row = loaded.bb.storage.database().prepare("SELECT state, gpus, down_first_at, stuck_flagged, mode, request_id, attempt_epoch FROM leases WHERE id = ?").get("lse_v1000000001");
    assert.deepEqual(row, { state: "active", gpus: 4, down_first_at: null, stuck_flagged: 0, mode: "created", request_id: null, attempt_epoch: 0 });
    assert.ok(loaded.harness.registrations.schedules.some((entry) => entry.name === "reconcile"));
  } finally {
    await loaded.harness.lifecycle.dispose();
  }
});
