import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./lib/store.ts";
import { createK8sLeasesPlugin } from "./server.ts";
import { BASE_SETTINGS, CLUSTER_A, HOUR, T0, THREAD_A, newUid } from "./test-support.ts";

const predecessorCreate = `CREATE TABLE leases (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    cluster TEXT NOT NULL,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    uid TEXT NOT NULL,
    gpu_type TEXT NOT NULL,
    gpus INTEGER NOT NULL CHECK (gpus > 0),
    hours REAL NOT NULL CHECK (hours > 0),
    multi_node INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    renewals INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('active','revoking','releasing','released','torn-down')),
    reason TEXT,
    revoked_at INTEGER,
    grace_deadline INTEGER,
    ended_at INTEGER,
    op_token TEXT,
    op_deadline INTEGER,
    ns_expires_at INTEGER,
    last_host TEXT,
    last_checked_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`;

test("reloading a database without deletion markers preserves its live leases and loads enforcement", async () => {
  let loaded = createFakePluginHost({ pluginId: "k8s-leases", settings: BASE_SETTINGS });
  try {
    const db = loaded.bb.storage.database();
    loaded.bb.storage.migrate(db, [predecessorCreate, ...MIGRATIONS.slice(1, 8)]);
    db.prepare(`INSERT INTO leases
      (id, thread_id, cluster, context, namespace, uid, gpu_type, gpus, hours, multi_node, created_at, expires_at, state)
      VALUES (?, ?, ?, ?, ?, ?, 'gb300', 4, 1, 0, ?, ?, 'active')`)
      .run("lse_upgrade000001", THREAD_A, CLUSTER_A, CLUSTER_A, "review-p4n-persisted", newUid(), T0, T0 + HOUR);
    assert.equal(db.prepare<[], { used: number }>("SELECT SUM(gpus) AS used FROM leases WHERE state = 'active'").get()!.used, 4);

    await assert.doesNotReject(async () => {
      loaded = await loaded.harness.lifecycle.reload(createK8sLeasesPlugin({ now: () => T0 }));
    }, "adding deletion markers must not reject the previously recorded migration and prevent enforcement from loading");

    const row = loaded.bb.storage.database().prepare("SELECT state, gpus, down_first_at, stuck_flagged FROM leases WHERE id = ?").get("lse_upgrade000001");
    assert.deepEqual(row, { state: "active", gpus: 4, down_first_at: null, stuck_flagged: 0 });
    assert.ok(loaded.harness.inspection.schedules.some((entry) => entry.name === "reconcile"));
  } finally {
    await loaded.harness.lifecycle.dispose();
  }
});
