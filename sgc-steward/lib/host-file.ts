// Files named on the `bb sgc` command line, read on the machine the command
// came from: the calling thread's, the `--machine` named, or the server's.
import { posix } from "node:path";
import { PluginCliError, type PluginBbSdk, type PluginCliContext } from "@get-bb/plugin-sdk";

/** The machine the CLI was called from: the thread's, `--machine`, or the server's. */
async function invokingHost(sdk: PluginBbSdk, ctx: PluginCliContext, machine: string | undefined): Promise<string | undefined> {
  if (machine !== undefined) {
    const hosts = await sdk.hosts.list();
    const matches = hosts.filter((host) => host.id === machine || host.name === machine);
    if (matches.length === 1) return matches[0]!.id;
    throw new PluginCliError(
      matches.length === 0 ? `No machine is named ${machine}.` : `${matches.length} machines are named ${machine}; use an id.`,
      { code: "unknown_machine", hint: "Run `bb machine list` for names and ids." },
    );
  }
  if (ctx.threadId === undefined) return undefined;
  const thread = await sdk.threads.get({ threadId: ctx.threadId });
  if (thread.environmentId === null) return undefined;
  return (await sdk.environments.get({ environmentId: thread.environmentId })).hostId;
}

/** Read a file named on the command line, at most `maxBytes`, on the machine the command came from. */
export async function readHostFile(
  sdk: PluginBbSdk,
  path: string,
  ctx: PluginCliContext,
  machine: string | undefined,
  flag: string,
  maxBytes: number,
): Promise<string> {
  let absolute = path;
  if (!posix.isAbsolute(path)) {
    if (ctx.cwd === undefined) {
      throw new PluginCliError(`${path} is relative and this command has no working directory.`, {
        code: "relative_path",
        hint: `Pass an absolute path to ${flag}.`,
      });
    }
    absolute = posix.resolve(ctx.cwd, path);
  }
  const hostId = await invokingHost(sdk, ctx, machine);
  const file = await sdk.files.read({ path: absolute, ...(hostId === undefined ? {} : { hostId }) });
  if (file.sizeBytes > maxBytes) {
    throw new PluginCliError(`${absolute} is over ${maxBytes} bytes.`, { code: "file_too_large" });
  }
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}
