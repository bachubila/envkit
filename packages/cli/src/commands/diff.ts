import { diffVariables, EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { openProject, readArgs } from "../variables.ts";

export const diff = defineCommand({
  meta: {
    name: "diff",
    description: "Compare the variable names of two environments: envkit diff dev prod",
  },
  args: {
    offline: readArgs.offline,
    check: {
      type: "boolean",
      description: "Exit with code 1 if either environment is missing a variable (for CI)",
    },
  },
  async run({ args }) {
    const context = useContext();
    const names = args._;
    if (names.length === 0 || names.length > 2) {
      throw new EnvkitError("Name one or two environments", {
        hint: "`envkit diff prod` compares the default environment with prod; `envkit diff dev prod` compares the two.",
      });
    }
    const project = await openProject(context, { offline: args.offline });
    const [leftName, rightName] =
      names.length === 2 ? names : [project.config.defaultEnvironment, names[0]];
    const left = await project.read(leftName);
    const right = await project.read(rightName);
    if (left.environment === right.environment) {
      throw new EnvkitError("Pick two different environments");
    }

    // Keys only: values never appear, just whether they match.
    const changes = diffVariables(left.variables, right.variables);
    const rows: [string, string[]][] = [
      [`only in ${left.environment}`, changes.removed],
      [`only in ${right.environment}`, changes.added],
      ["different", changes.changed],
    ];
    const width = Math.max(...rows.map(([label]) => label.length)) + 1;
    context.output.stdout(`${left.environment} → ${right.environment}`);
    for (const [label, list] of rows) {
      if (list.length) context.output.stdout(`  ${`${label}:`.padEnd(width)}  ${list.join(", ")}`);
    }
    const same = changes.unchanged.length;
    context.output.stdout(`  ${"same:".padEnd(width)}  ${same} variable${same === 1 ? "" : "s"}`);

    if (args.check && (changes.added.length > 0 || changes.removed.length > 0)) {
      context.exitCode = 1;
    }
  },
});
