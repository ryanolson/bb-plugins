// The page is bundled for the browser, which has no Node builtins. A page
// module that reaches one through its imports breaks `bb plugin update` at
// build time, not in any test of the server, so this walks the page's import
// graph and fails on the first `node:` import it finds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The specifiers a module imports or re-exports as values: `import type` and `export type` are erased and skipped. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/gm)) {
    if (match[2] === undefined) found.push(match[4]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(match[1]!);
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? resolve(ROOT, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (base === null) return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((path) => /\.tsx?$/.test(path) && existsSync(path)) ?? null;
}

/** Each Node builtin a page module reaches, as "chain of files -> builtin". */
export function nodeImportsReachedFrom(entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of valueImports(readFileSync(file, "utf8"))) {
      if (BUILTINS.has(specifier)) {
        problems.push(`${[...chain, file].map((path) => path.slice(ROOT.length + 1)).join(" -> ")} -> ${specifier}`);
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next !== null) visit(next, [...chain, file]);
    }
  };
  visit(entry, []);
  return problems;
}

test("the page imports no module that reaches a Node builtin", () => {
  assert.deepEqual(nodeImportsReachedFrom(resolve(ROOT, "app.tsx")), []);
});

test("the walk finds a builtin behind a value import, and skips import type", () => {
  assert.equal(valueImports('import type { A } from "node:fs";\nimport { b } from "./b.ts";\nexport { c } from "./c.ts";\nexport type { D } from "node:os";').join(","), "./b.ts,./c.ts");
});
