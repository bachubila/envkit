import { EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };

export const main = defineCommand({
  meta: {
    name: "envkit",
    version: pkg.version,
    description: "Share environment variables with your team through a self-hosted Vaultwarden.",
  },
  // Phase 0 has no subcommands yet. Once `subCommands` is populated, drop this
  // `run`: citty runs the parent's `run` after a subcommand and reports unknown
  // commands itself.
  run({ args }) {
    const [command] = args._;
    if (command !== undefined) {
      throw new EnvkitError(`Unknown command "${command}"`, {
        hint: "Run `envkit --help` to see the available commands.",
      });
    }
    return { showUsage: true };
  },
});
