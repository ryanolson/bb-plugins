import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("unload observes a teardown rejection even while its step is waiting on inspect", () => {
  const scenario = `
    import assert from "node:assert/strict";
    import { setImmediate } from "node:timers/promises";
    import { HOST_ONE, HOUR, THREAD_A, setup } from "./test-support.ts";
    const world = await setup({ hosts: JSON.stringify([HOST_ONE]) });
    await world.tick();
    const { id, result } = await world.lease(THREAD_A, "review-p4-unload-expire", 4, { hours: 1 });
    assert.equal(result.code, 0);
    const handle = world.guard.handle.bind(world.guard);
    let startExpire, startInspect, finishExpire, finishInspect;
    const expiring = new Promise((resolve) => { startExpire = resolve; });
    const inspecting = new Promise((resolve) => { startInspect = resolve; });
    const expireResponse = new Promise((resolve) => { finishExpire = resolve; });
    const inspectResponse = new Promise((resolve) => { finishInspect = resolve; });
    function waitForResponse(method, response) {
      const call = world.harness.inspection.experimental_hostRpcCalls.findLast((call) => call.method === method);
      assert.ok(call.signal);
      return new Promise((resolve, reject) => {
        response.then(resolve, reject);
        call.signal.addEventListener("abort", () => reject(Object.assign(new Error("Host plugin call was cancelled"), { name: "AbortError" })), { once: true });
      });
    }
    world.guard.handle = async (method, input, hostId) => {
      if (input.namespace === "review-p4-unload-expire") {
        if (method === "expire") {
          startExpire();
          await waitForResponse(method, expireResponse);
          return { ok: false, code: "guard_timeout", error: "expire failed after unload" };
        }
        if (method === "inspect") {
          startInspect();
          await waitForResponse(method, inspectResponse);
        }
      }
      return handle(method, input, hostId);
    };
    world.clock.advance(HOUR);
    const tick = world.tick();
    await Promise.all([expiring, inspecting]);
    if (process.argv[1] === "reload") await world.reload();
    finishExpire();
    await setImmediate();
    await setImmediate();
    finishInspect();
    await tick;
    await world.harness.lifecycle.dispose();
  `;
  const run = (mode: string) => spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", scenario, mode], {
    cwd: import.meta.dirname,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  const control = run("loaded");
  assert.equal(control.status, 0, control.stderr);
  const reloaded = run("reload");
  assert.equal(reloaded.error, undefined);
  assert.equal(reloaded.signal, null);
  assert.equal(reloaded.status, 0, `reload left the teardown promise unobserved while inspect was pending:\n${reloaded.stderr}`);
});
