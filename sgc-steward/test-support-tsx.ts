// Lets `node --test` import the page's `.tsx` components. Node strips types
// from `.ts` files but cannot read JSX, so this hook transpiles `.tsx` with the
// TypeScript compiler the plugin already has, and resolves the `@/` path alias
// that `tsconfig.json` declares. Import it before the first `.tsx` import.
//
// Tests that render a component also need bb's plugin runtime: see
// `installMarkdownRuntime`, which stands in for the host's `Markdown`.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode } from "react";
import * as React from "react";
import ts from "typescript";

const ROOT = new URL("./", import.meta.url);

/** `@/lib/utils` names a file without its extension; try the ones the page uses. */
function aliasTarget(specifier: string): string | null {
  const base = fileURLToPath(new URL(specifier.slice(2), ROOT));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = aliasTarget(specifier);
      if (target !== null) return { url: target, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        rewriteRelativeImportExtensions: true,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

/** One call of the host's `Markdown`, as the page made it. */
export interface MarkdownCall {
  content: string;
  className: string | undefined;
}

/**
 * Install a stand-in for bb's plugin runtime whose `Markdown` records each
 * call and renders its source in a marked `div`. bb's own renderer is not
 * available outside the app, so a test checks that text reaches `Markdown`
 * whole; what bb draws from it is bb's contract.
 */
export function installMarkdownRuntime(): MarkdownCall[] {
  const calls: MarkdownCall[] = [];
  function Markdown({ content, className }: { content: string; className?: string }): ReactNode {
    calls.push({ content, className });
    return createElement("div", { "data-bb-markdown": "", className }, content);
  }
  (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime = { react: React, pluginSdkApp: { Markdown } };
  return calls;
}
