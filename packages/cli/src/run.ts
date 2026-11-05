import { isEnvkitError } from "@envkit/core";
import { renderUsage, runCommand, type ArgsDef, type CommandDef, type CommandMeta } from "citty";
import { createContext, withContext, type CliContext } from "./context.ts";
import { main } from "./main.ts";

const NON_INTERACTIVE = "--non-interactive";

/**
 * Runs the CLI and resolves to the process exit code. Unlike citty's `runMain`
 * it never calls `process.exit`, so tests can drive it in-process and replace
 * any part of the context.
 */
export async function run(
  rawArgs: string[],
  overrides: Partial<CliContext> = {},
  command: CommandDef<ArgsDef> = main as CommandDef<ArgsDef>,
): Promise<number> {
  const context = createContext(overrides);
  const { output } = context;
  try {
    // Anything after `--` belongs to the command `envkit run` starts.
    const separator = rawArgs.indexOf("--");
    const before = separator === -1 ? rawArgs : rawArgs.slice(0, separator);
    const after = separator === -1 ? [] : rawArgs.slice(separator);
    // A global flag, so it's handled here rather than by each command.
    const ownArgs = before.filter((arg) => arg !== NON_INTERACTIVE);
    if (ownArgs.length !== before.length) context.interactive = false;
    const args = [...ownArgs, ...after];
    if (args.length === 0 || ownArgs.includes("--help") || ownArgs.includes("-h")) {
      const [target, parent] = await resolveSubCommand(command, ownArgs);
      output.stdout(await renderUsage(target, parent));
      return 0;
    }
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      const meta = (await resolve(command.meta)) as CommandMeta | undefined;
      output.stdout(meta?.version ?? "unknown");
      return 0;
    }
    await withContext(context, () => runCommand(command, { rawArgs: args }));
    return context.exitCode ?? 0;
  } catch (error) {
    if (isEnvkitError(error)) {
      output.stderr(`error: ${error.message}`);
      if (error.hint) output.stderr(error.hint);
      return error.exitCode;
    }
    if (error instanceof Error && error.name === "CLIError") {
      output.stderr(`error: ${error.message}`);
      output.stderr("Run `envkit --help` for usage.");
      return 1;
    }
    output.stderr(`envkit crashed unexpectedly. This is a bug, please report it.`);
    output.stderr(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 70;
  }
}

/**
 * The (sub)command `rawArgs` points at, plus a stand-in parent whose name is
 * the full command path (e.g. "envkit env"), so usage reads `envkit env add`.
 */
async function resolveSubCommand(
  command: CommandDef,
  rawArgs: string[],
  path: string[] = [],
): Promise<[CommandDef, CommandDef | undefined]> {
  const meta = (await resolve(command.meta)) as CommandMeta | undefined;
  const here = [...path, meta?.name ?? ""];
  const subCommands = (await resolve(command.subCommands)) ?? {};
  const index = rawArgs.findIndex((arg) => !arg.startsWith("-"));
  const name = index === -1 ? undefined : rawArgs[index];
  const sub = name === undefined ? undefined : subCommands[name];
  if (!sub) {
    return [command, path.length > 0 ? { meta: { name: path.join(" ") } } : undefined];
  }
  return resolveSubCommand(await resolve(sub), rawArgs.slice(index + 1), here);
}

async function resolve<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}
