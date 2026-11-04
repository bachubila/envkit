import {
  applyVariableChanges,
  diffVariables,
  EnvkitError,
  isValidVariableName,
  type VariableChanges,
} from "@envkit/core";
import { defineCommand } from "citty";
import { useContext, type CliContext } from "../context.ts";
import { openProject, type EnvironmentData } from "../variables.ts";

const envArg = {
  env: {
    type: "string",
    alias: "e",
    description: "Environment to change (default: the project's default)",
  },
} as const;

export const set = defineCommand({
  meta: {
    name: "set",
    description:
      "Set variables: envkit set KEY=value … (or `envkit set KEY` to read the value from stdin or a prompt)",
  },
  args: envArg,
  async run({ args }) {
    const context = useContext();
    const assignments = await parseAssignments(context, args._);
    await changeVariables(context, args.env, (current) => {
      const changes = new Map<string, string>();
      for (const [name, value] of assignments) {
        if (current.get(name) !== value) changes.set(name, value);
      }
      return { set: changes };
    });
  },
});

export const unset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove variables: envkit unset KEY …",
  },
  args: envArg,
  async run({ args }) {
    const context = useContext();
    const names = args._;
    if (names.length === 0) {
      throw new EnvkitError("Name the variables to remove", {
        hint: "e.g. `envkit unset OLD_KEY`",
      });
    }
    await changeVariables(context, args.env, (current, environment) => {
      for (const name of names) {
        if (!current.has(name)) context.output.stderr(`${name} is not set in "${environment}".`);
      }
      return { unset: names.filter((name) => current.has(name)) };
    });
  },
});

/** `KEY=value` pairs; a single bare `KEY` reads its value from stdin or a hidden prompt. */
async function parseAssignments(
  context: CliContext,
  rawPairs: string[],
): Promise<Map<string, string>> {
  if (rawPairs.length === 0) {
    throw new EnvkitError("Give at least one KEY=value", {
      hint: "Or `envkit set KEY` and type or pipe the value, which keeps it out of your shell history.",
    });
  }
  const assignments = new Map<string, string>();
  const bare: string[] = [];
  for (const pair of rawPairs) {
    const index = pair.indexOf("=");
    const name = index === -1 ? pair : pair.slice(0, index);
    if (!isValidVariableName(name)) {
      throw new EnvkitError(`Invalid variable name "${name}"`, {
        hint: "Use letters, digits and underscores, not starting with a digit.",
      });
    }
    if (index === -1) bare.push(name);
    else assignments.set(name, pair.slice(index + 1));
  }
  if (bare.length > 1) {
    throw new EnvkitError("Only one variable can read its value from stdin", {
      hint: `Give the others as KEY=value: ${bare.join(", ")}.`,
    });
  }
  const [name] = bare;
  if (name) assignments.set(name, await readValue(context, name));
  return assignments;
}

async function readValue(context: CliContext, name: string): Promise<string> {
  const piped = await context.readStdin();
  if (piped !== undefined) return piped.replace(/\r?\n$/, "");
  if (!context.interactive) {
    throw new EnvkitError(`No value for ${name}`, {
      hint: `Use \`envkit set ${name}=value\` or pipe it: \`printf %s "$VALUE" | envkit set ${name}\`.`,
    });
  }
  return context.prompt.password(`Value for ${name}`);
}

/**
 * Read-modify-write of one environment. Always syncs first; the backend
 * refuses the write if someone saved the item in between.
 */
export async function changeVariables(
  context: CliContext,
  environmentName: string | undefined,
  plan: (
    current: Map<string, string>,
    environment: string,
  ) => { set?: Map<string, string>; unset?: string[] },
  confirm?: (changes: VariableChanges, data: EnvironmentData) => Promise<boolean>,
): Promise<void> {
  const project = await openProject(context, { sync: "always" });
  const data = await project.read(environmentName);
  const { set = new Map(), unset = [] } = plan(data.variables, data.environment);
  if (set.size === 0 && unset.length === 0) {
    context.output.stdout(`Nothing to change in "${data.environment}".`);
    return;
  }

  const after = new Map(data.variables);
  for (const [name, value] of set) after.set(name, value);
  for (const name of unset) after.delete(name);
  const changes = diffVariables(data.variables, after);
  if (confirm && !(await confirm(changes, data))) {
    context.output.stdout("Nothing changed.");
    return;
  }

  await context.backend().updateItem(project.session, {
    ...data.item,
    fields: applyVariableChanges(data.item.fields, { set, unset }),
  });
  context.output.stdout(summarize(changes, data.environment));
}

export function summarize(changes: VariableChanges, environment: string): string {
  const parts = [
    changes.added.length ? `added ${changes.added.join(", ")}` : "",
    changes.changed.length ? `updated ${changes.changed.join(", ")}` : "",
    changes.removed.length ? `removed ${changes.removed.join(", ")}` : "",
  ].filter(Boolean);
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} in "${environment}".`;
}
