// Browser-safe: the page imports this file, so it must import nothing that
// reaches a Node builtin (lib/page-imports.test.ts guards it).

const LINEAR_WEB = "https://linear.app/";

/**
 * A Linear web link as the Linear app opens it: https://linear.app/<ws>/<rest>
 * becomes linear://<ws>/<rest>. Any other text, a lookalike host included,
 * comes back as it was. Only the page uses this; the CLI keeps https.
 */
export function appLink(url: string): string {
  return url.startsWith(LINEAR_WEB) && url.length > LINEAR_WEB.length ? `linear://${url.slice(LINEAR_WEB.length)}` : url;
}
