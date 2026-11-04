import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { formatVariables, OUTPUT_FORMATS, type OutputFormat } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { loadVariables, readArgs } from "../variables.ts";

export const pull = defineCommand({
  meta: {
    name: "pull",
    description: "Print the environment's variables, or write them to a file with --out",
  },
  args: {
    ...readArgs,
    out: {
      type: "string",
      alias: "o",
      description: "Write to this file (mode 600) instead of stdout",
      valueHint: ".env",
    },
    format: {
      type: "enum",
      options: OUTPUT_FORMATS,
      default: "dotenv",
      description: "dotenv, json, or shell (`export` lines for eval)",
    },
  },
  async run({ args }) {
    const context = useContext();
    // citty has already rejected values outside OUTPUT_FORMATS.
    const format = args.format as OutputFormat;
    const { environment, variables } = await loadVariables(context, args);
    const text = formatVariables(variables, format);

    if (!args.out) {
      // Every line already ends in a newline; stdout() adds one more.
      context.output.stdout(text.replace(/\n$/, ""));
      return;
    }

    const path = isAbsolute(args.out) ? args.out : resolve(context.cwd, args.out);
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
    const shown = relative(context.cwd, path) || path;
    context.output.stderr(
      `Wrote ${variables.size} variable${variables.size === 1 ? "" : "s"} from "${environment}" to ${shown}.`,
    );
    if ((await gitTracksPath(context.cwd, path)) === "not-ignored") {
      context.output.stderr(
        `warning: ${shown} is not ignored by git. Add it to .gitignore so secrets don't get committed.`,
      );
    }
  },
});

const exec = promisify(execFile);

/** Whether git would pick up `path`: "not-ignored", "ignored", or "no-repo" (or no git). */
async function gitTracksPath(
  cwd: string,
  path: string,
): Promise<"ignored" | "not-ignored" | "no-repo"> {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return "no-repo";
  }
  try {
    // Exit code 0: ignored. 1: not ignored.
    await exec("git", ["check-ignore", "--quiet", "--no-index", path], { cwd });
    return "ignored";
  } catch (error) {
    return (error as { code?: number }).code === 1 ? "not-ignored" : "no-repo";
  }
}
