import { isEnvkitError } from "@envkit/core";
import { renderUsage, runCommand, type CommandDef, type CommandMeta } from "citty";
import { main } from "./main.ts";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processOutput: Output = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/**
 * Runs the CLI and resolves to the process exit code. Unlike citty's `runMain`
 * it never calls `process.exit`, so tests can drive it in-process.
 */
export async function run(
  rawArgs: string[],
  output: Output = processOutput,
  command: CommandDef = main,
): Promise<number> {
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      output.stdout(await renderUsage(command));
      return 0;
    }
    if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
      const meta = (await resolve(command.meta)) as CommandMeta | undefined;
      output.stdout(meta?.version ?? "unknown");
      return 0;
    }
    const { result } = await runCommand(command, { rawArgs });
    if (isUsageRequest(result)) output.stdout(await renderUsage(command));
    return 0;
  } catch (error) {
    if (isEnvkitError(error)) {
      output.stderr(`error: ${error.message}`);
      if (error.hint) output.stderr(error.hint);
      return error.exitCode;
    }
    if (error instanceof Error && error.name === "CLIError") {
      output.stderr(`error: ${error.message}`);
      output.stderr("Run `envkit --help` to see the available commands.");
      return 1;
    }
    output.stderr(`envkit crashed unexpectedly. This is a bug, please report it.`);
    output.stderr(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 70;
  }
}

function isUsageRequest(result: unknown): boolean {
  return typeof result === "object" && result !== null && "showUsage" in result;
}

async function resolve<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}
