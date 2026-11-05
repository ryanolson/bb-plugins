import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("a down failure after reload must not reject an unobserved promise against the closed database", { todo: "p3 f5 [lifecycle]: work in flight at reload hits the closed database; waits on the redesign" }, () => {
  const scenario = `
    import assert from "node:assert/strict";
    import { setImmediate } from "node:timers/promises";
    import { HOST_ONE, THREAD_A, setup } from "./test-support.ts";
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    await world.tick();
    const { id, ns, result } = await world.lease(THREAD_A, "review-p3-reload-down", 4);
    assert.equal(result.code, 0);
    world.cluster.setDgd(ns, "worker", 4);
    const handle = world.guard.handle.bind(world.guard);
    let entered;
    let resume;
    const running = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { resume = resolve; });
    world.guard.handle = async (method, input, hostId) => {
      if (method === "down" && input.leaseId === id) {
        entered();
        await held;
        if (process.argv[1] === "fail") return { ok: false, code: "guard_timeout", error: "down failed after the plugin reloaded" };
      }
      return handle(method, input, hostId);
    };
    const release = world.cli(["lease", "release", id], THREAD_A);
    await running;
    const reloading = world.reload();
    await setImmediate();
    resume();
    await reloading;
    await release;
    await setImmediate();
    await world.harness.lifecycle.dispose();
  `;
  const run = (outcome: string) => spawnSync(process.execPath, ["--input-type=module", "--eval", scenario, outcome], {
      cwd: import.meta.dirname,
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
  const control = run("success");
  assert.equal(control.status, 0, control.stderr);
  const child = run("fail");
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, `reload left an unhandled rejection in the server process:\n${child.stderr}`);
});
