import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { Panel } from "./contract.ts";
import { setup } from "../test-support.ts";

test("withdraw review F1: BB_THREAD_ID cannot grant steward authority", {
  skip: "F1: withdraw trusts the caller's BB_THREAD_ID as steward identity",
}, async (t) => {
  const { harness, sends } = await setup({ key: null });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({ stewardThread: "thr_steward" });
  const asked = await harness.behavior.runCli(["ask", "--question", "Keep this decision open?", "--json"], { threadId: "thr_asker" });
  assert.equal(asked.exitCode, 0, asked.stderr);
  const { id } = JSON.parse(asked.stdout) as { id: string };
  const contexts: PluginCliContext[] = [];

  // Only loopback traffic reaches this fixture. Every plugin SDK call is fake.
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/v1/plugins/contributions") {
      response.end(JSON.stringify({ cliCommands: [{ pluginId: "sgc-steward", name: "sgc", commands: [] }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/plugins/sgc-steward/cli") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { argv, ...ctx } = JSON.parse(body) as PluginCliContext & { argv: string[] };
      contexts.push(ctx);
      response.end(JSON.stringify(await harness.behavior.runCli(argv, ctx)));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const invoke = (threadId: string) => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile("bb", ["sgc", "withdraw", id, "--reason", "Withdraw through a forged caller.", "--json"], {
      env: { PATH: process.env.PATH, BB_SERVER_URL: url, BB_THREAD_ID: threadId },
      timeout: 5000,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ exitCode: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ exitCode: error.code, stdout, stderr });
      else reject(error);
    });
  });

  const ordinary = await invoke("thr_other");
  assert.equal(ordinary.exitCode, 1, ordinary.stderr);
  assert.match(ordinary.stderr, /asked by another thread/);
  const before = await harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual(before.asks.map((ask) => ask.id), [id]);
  assert.deepEqual(sends, []);

  const forged = await invoke("thr_steward");
  assert.deepEqual(contexts.map((ctx) => ctx.threadId), ["thr_other", "thr_steward"]);
  const after = await harness.behavior.callRpc("questions.list", null) as Panel;
  assert.deepEqual({ exitCode: forged.exitCode, open: after.asks.length, notices: sends.length },
    { exitCode: 1, open: 1, notices: 0 },
    "a CLI environment variable cannot authenticate the configured steward");
});
