import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";

// Known limit F3, accepted by the owner: every agent runs as the owner with
// full access, and bb has no setting that only the owner can change, so an
// agent can run `bb plugin config` and name itself the steward. This test pins
// that behavior; a fix for the limit must change it on purpose.
test("withdraw review F3 (known limit): changing stewardThread through the configuration CLI moves steward rights", async (t) => {
  const { harness, sends } = await setup({ key: null });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const asked = await harness.behavior.runCli(["ask", "--question", "Keep this decision open?", "--json"], { threadId: "thr_asker" });
  assert.equal(asked.exitCode, 0, asked.stderr);
  const { id } = JSON.parse(asked.stdout) as { id: string };
  const invokeTool = () => harness.behavior.callAgentTool("sgc_withdraw_question", { id, reason: "Decided elsewhere." }, { threadId: "thr_other" });
  const denied = await invokeTool();
  assert.equal(typeof denied === "string" ? false : denied.isError, true);
  assert.equal(sends.length, 0);

  const writes: unknown[] = [];
  let stewardThread = "thr_steward";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/v1/plugins/sgc-steward/settings" || !["GET", "PUT"].includes(request.method ?? "")) {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.method === "PUT") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as { values: { stewardThread: string } };
      writes.push(input);
      await harness.behavior.setSettings(input.values);
      stewardThread = input.values.stewardThread;
    }
    response.end(JSON.stringify({ ok: true, schema: { stewardThread: { type: "string", label: "Steward thread" } }, values: { stewardThread } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const configured = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    execFile("bb", ["plugin", "config", "sgc-steward", "set", "stewardThread", "thr_other", "--json"], {
      env: { PATH: process.env.PATH, BB_SERVER_URL: url, BB_THREAD_ID: "thr_other" }, timeout: 5000,
    }, (error, _stdout, stderr) => {
      if (!error) resolve({ exitCode: 0, stderr });
      else if (typeof error.code === "number") resolve({ exitCode: error.code, stderr });
      else reject(error);
    });
  });
  assert.equal(configured.exitCode, 0, configured.stderr);
  assert.deepEqual(writes, [{ values: { stewardThread: "thr_other" } }]);

  const result = await invokeTool();
  const panel = await harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual({ refused: typeof result === "string" ? false : result.isError === true, open: panel.asks.length, notices: sends.length },
    { refused: false, open: 0, notices: 1 },
    "known limit F3: the thread stewardThread names holds steward rights, and any agent can change the setting");
});
