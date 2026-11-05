// The limits change while renew, extend and acquire run at once. Sweep the
// moment of the change over many microtask depths. An operation that had not
// committed when the change landed must check the new limits and be refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLUSTER_B, HOST_ONE, THREAD_A, THREAD_B, setup } from "./test-support.ts";

test("a limit change, then renew, extend and acquire at once: each uses the new limit", async () => {
  const violations: string[] = [];
  const refused = { renew: 0, extend: 0, acquire: 0 };
  for (let depth = 0; depth < 40; depth += 1) {
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    try {
      await world.tick();
      const { id } = await world.lease(THREAD_A, "dyntest-race", 1, { hours: 2 });
      const ns = world.cluster.create(CLUSTER_B, "dyntest-race-next", THREAD_B);
      const db = world.bb.storage.database();
      const lease = db.prepare<[string], { renewals: number; expires_at: number }>("SELECT renewals, expires_at FROM leases WHERE id = ?");
      const extensions = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM extensions WHERE lease_id = ? AND source = 'panel'");
      const onNs = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM leases WHERE namespace = ?");
      let atChange: { renewed: boolean; extended: boolean; acquired: boolean } | null = null;
      let change: Promise<void> = Promise.resolve();
      const changed = new Promise<void>((done) => {
        const schedule = (left: number): void => {
          if (left > 0) return void queueMicrotask(() => schedule(left - 1));
          atChange = { renewed: lease.get(id)!.renewals > 0, extended: extensions.get(id)!.n > 0, acquired: onNs.get(ns.name)!.n > 0 };
          change = world.harness.behavior.setSettings({ maxRenewals: 0, maxExtendHours: 1, gpuLimits: JSON.stringify({ gb300: 1 }) });
          done();
        };
        queueMicrotask(() => schedule(depth));
      });
      const [renewed, extended, acquired] = await Promise.all([
        world.cli(["lease", "renew", id], THREAD_A),
        world.harness.behavior.callRpc("extend", { leaseId: id, minutes: 120 }).then(
          () => true,
          () => false,
        ),
        world.acquire(THREAD_B, ns, 1),
      ]);
      await changed;
      await change;
      const seen = atChange!;
      if (renewed.code !== 0) refused.renew += 1;
      else if (!seen.renewed) violations.push(`depth ${depth}: renew committed after the change`);
      if (!extended) refused.extend += 1;
      else if (!seen.extended) violations.push(`depth ${depth}: extend committed after the change`);
      if (acquired.code !== 0) refused.acquire += 1;
      else if (!seen.acquired) violations.push(`depth ${depth}: acquire committed after the change`);
    } finally {
      await world.harness.lifecycle.dispose();
    }
  }
  assert.ok(refused.renew > 0 && refused.extend > 0 && refused.acquire > 0, `early changes refuse each one: ${JSON.stringify(refused)}`);
  assert.deepEqual(violations, []);
});
