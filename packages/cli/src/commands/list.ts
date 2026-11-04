import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { loadVariables, readArgs } from "../variables.ts";

const MASK = "********";

export const list = defineCommand({
  meta: {
    name: "list",
    description: "List the environment's variable names (values hidden unless --reveal)",
  },
  args: {
    ...readArgs,
    reveal: { type: "boolean", description: "Show the values too" },
  },
  async run({ args }) {
    const context = useContext();
    const { environment, variables } = await loadVariables(context, args);
    if (variables.size === 0) {
      context.output.stderr(`"${environment}" has no variables yet.`);
      return;
    }
    const names = [...variables.keys()].sort();
    const width = Math.max(...names.map((name) => name.length));
    for (const name of names) {
      context.output.stdout(`${name.padEnd(width)}  ${args.reveal ? variables.get(name) : MASK}`);
    }
  },
});
