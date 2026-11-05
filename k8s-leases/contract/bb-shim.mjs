#!/usr/bin/env node
// `bb` for the contract test: sends `bb k8s ...` to the test process, where
// the plugin runs on bb's fake host, and prints the plugin's answer.
const port = process.env.CONTRACT_BB_PORT;
const response = await fetch(`http://127.0.0.1:${port}/cli`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ argv: process.argv.slice(2), threadId: process.env.BB_THREAD_ID ?? null }),
});
const { exitCode, stdout, stderr } = await response.json();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(exitCode);
