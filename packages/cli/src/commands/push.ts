import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EnvkitError, parseDotenv } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { changeVariables } from "./set.ts";

export const push = defineCommand({
  meta: {
    name: "push",
    description: "Upload variables from a .env file, showing what changes first",
  },
  args: {
    from: {
      type: "string",
      default: ".env",
      description: "File to read, or - for stdin",
      valueHint: "file",
    },
    env: {
      type: "string",
      alias: "e",
      description: "Environment to change (default: the project's default)",
    },
    prune: {
      type: "boolean",
      description: "Also remove variables that aren't in the file",
    },
    yes: { type: "boolean", alias: "y", description: "Don't ask for confirmation" },
  },
  async run({ args }) {
    const context = useContext();
    const text = await readSource(args.from);
    const { variables: incoming, warnings } = parseDotenv(text);
    for (const warning of warnings) context.output.stderr(`warning: ${warning}`);
    if (incoming.size === 0 && !args.prune) {
      throw new EnvkitError(`No variables in ${args.from}`);
    }

    await changeVariables(
      context,
      args.env,
      (current) => {
        const set = new Map<string, string>();
        for (const [name, value] of incoming) if (current.get(name) !== value) set.set(name, value);
        const unset = args.prune ? [...current.keys()].filter((name) => !incoming.has(name)) : [];
        return { set, unset };
      },
      async (changes, { environment }) => {
        // Keys only: values never appear in the preview.
        context.output.stdout(`Changes to "${environment}":`);
        for (const name of changes.added) context.output.stdout(`  + ${name}`);
        for (const name of changes.changed) context.output.stdout(`  ~ ${name}`);
        for (const name of changes.removed) context.output.stdout(`  - ${name}`);
        if (changes.unchanged.length) {
          context.output.stdout(`  (${changes.unchanged.length} unchanged)`);
        }
        if (args.yes) return true;
        if (!context.interactive) {
          throw new EnvkitError("Refusing to change variables without confirmation", {
            hint: "Pass --yes to apply these changes without a terminal.",
          });
        }
        return context.prompt.confirm(`Apply these changes to "${environment}"?`);
      },
    );

    async function readSource(from: string): Promise<string> {
      if (from === "-") {
        const piped = await context.readStdin();
        if (piped === undefined) throw new EnvkitError("Nothing piped into stdin");
        return piped;
      }
      try {
        return await readFile(resolve(context.cwd, from), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new EnvkitError(`${from} not found`, { hint: "Pass the file with --from." });
        }
        throw error;
      }
    }
  },
});
