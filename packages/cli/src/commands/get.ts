import { EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { loadVariables, readArgs } from "../variables.ts";

export const get = defineCommand({
  meta: {
    name: "get",
    description: "Print one variable's value, e.g. for scripts: $(envkit get API_KEY)",
  },
  args: {
    name: { type: "positional", description: "Variable name", required: true },
    ...readArgs,
  },
  async run({ args }) {
    const context = useContext();
    const { environment, variables } = await loadVariables(context, args);
    const value = variables.get(args.name);
    if (value === undefined) {
      throw new EnvkitError(`No variable ${args.name} in "${environment}"`, {
        hint: "Run `envkit list` to see the variable names.",
      });
    }
    context.output.stdout(value);
  },
});
