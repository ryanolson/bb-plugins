// The plugin imports only public bb SDK entrypoints, so it builds and runs
// outside the bb repository.
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("only public SDK imports, and no private @bb packages", async () => {
  const scan = await experimental_scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
    allow: [/^better-sqlite3$/, /^@get-bb\/plugin-sdk\/testing$/, /^@\/(components|lib)\//, /^react(-dom)?(\/.*)?$/, /^sonner$/, /^clsx$/, /^tailwind-merge$/, /^class-variance-authority$/, /^@radix-ui\//],
  });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
