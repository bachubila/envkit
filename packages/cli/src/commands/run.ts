import { spawn } from "node:child_process";
import { constants } from "node:os";
import { buildChildEnv, EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { loadVariables, readArgs } from "../variables.ts";

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a command with the environment's variables: envkit run -- <command>",
  },
  args: {
    ...readArgs,
    override: {
      type: "boolean",
      default: true,
      description: "Let vault values replace variables already set in the shell",
      negativeDescription: "Keep variables already set in the shell",
    },
  },
  async run({ args, rawArgs }) {
    const context = useContext();
    const separator = rawArgs.indexOf("--");
    const command = separator === -1 ? [] : rawArgs.slice(separator + 1);
    if (command.length === 0) {
      throw new EnvkitError("No command to run", {
        hint: "Put it after `--`, e.g. `envkit run -- npm start`.",
      });
    }

    const { variables } = await loadVariables(context, args);
    const env = buildChildEnv(context.env, variables, { override: args.override });
    context.exitCode = await spawnAndWait(command, env, context.cwd);
  },
});

/**
 * Runs the command with inherited stdio, forwards termination signals to it,
 * and resolves to its exit code (128 + signal number if a signal killed it).
 */
function spawnAndWait(
  [file, ...args]: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file!, args, { stdio: "inherit", env, cwd });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const cleanup = () => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        error.code === "ENOENT"
          ? new EnvkitError(`Command not found: ${file}`, { exitCode: 127 })
          : error,
      );
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}
