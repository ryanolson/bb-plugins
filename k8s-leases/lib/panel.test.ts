import assert from "node:assert/strict";
import { test } from "node:test";
import { QUICK_EXTENDS, customMinutes, sortLeases, timeLeft } from "./panel.ts";
import type { LeaseView } from "./contract.ts";

const MIN = 60_000;

function lease(over: Partial<LeaseView>): LeaseView {
  return {
    id: "lse_test000001",
    thread: "thr_aaaa1111",
    cluster: "test-cluster-a",
    namespace: "dyntest-a",
    gpuType: "gb300",
    gpus: 4,
    multiNode: false,
    state: "active",
    reason: null,
    createdAt: 0,
    expiresAt: 90 * MIN,
    graceDeadline: null,
    renewals: 0,
    extensions: [],
    lastError: null,
    extendBlocked: null,
    ...over,
  };
}

test("quick choices are +30 min, +1 h and +2 h", () => {
  assert.deepEqual(
    QUICK_EXTENDS.map((q) => [q.label, q.minutes]),
    [
      ["+30 min", 30],
      ["+1 h", 60],
      ["+2 h", 120],
    ],
  );
});

test("a custom amount in minutes or hours, within the cap", () => {
  assert.deepEqual(customMinutes("45", "min", 24), { ok: true, minutes: 45 });
  assert.deepEqual(customMinutes("1.5", "h", 24), { ok: true, minutes: 90 });
  assert.equal(customMinutes("", "min", 24).ok, false);
  assert.equal(customMinutes("-5", "min", 24).ok, false);
  assert.equal(customMinutes("abc", "h", 24).ok, false);
  assert.equal(customMinutes("0", "h", 24).ok, false);
  const over = customMinutes("25", "h", 24);
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.error, /24 h/);
});

test("time left: minutes and hours for active, the deletion time for revoking", () => {
  assert.equal(timeLeft(lease({}), 0), "1 h 30 min left");
  assert.equal(timeLeft(lease({ expiresAt: 5 * MIN }), 0), "5 min left");
  assert.equal(timeLeft(lease({ expiresAt: 0 }), MIN), "expired");
  assert.equal(timeLeft(lease({ state: "revoking", graceDeadline: 40 * MIN }), 0), "deleted in 40 min");
  assert.equal(timeLeft(lease({ state: "released" }), 0), "");
});

test("leases sort live first, then by expiry", () => {
  const sorted = sortLeases([
    lease({ id: "lse_ended0001", state: "released", expiresAt: 1 }),
    lease({ id: "lse_later0001", expiresAt: 100 }),
    lease({ id: "lse_soon00001", expiresAt: 10 }),
    lease({ id: "lse_revoke001", state: "revoking", expiresAt: 5 }),
  ]);
  assert.deepEqual(
    sorted.map((l) => l.id),
    ["lse_revoke001", "lse_soon00001", "lse_later0001", "lse_ended0001"],
  );
});
