import {
  BwError,
  EnvkitError,
  loadConfig,
  needsSync,
  readVariables,
  resolveEnvironment,
  syncIntervalFromEnv,
  type EnvkitConfig,
} from "@envkit/core";
import type { CliContext } from "./context.ts";
import { warnOnServerMismatch } from "./project.ts";
import { requireSession } from "./session.ts";

/** Flags shared by every command that reads an environment's variables. */
export const readArgs = {
  env: {
    type: "string",
    alias: "e",
    description: "Environment to use (default: the project's default)",
  },
  offline: {
    type: "boolean",
    description: "Don't sync with the server first; use the local copy of the vault",
  },
} as const;

export interface LoadedVariables {
  config: EnvkitConfig;
  environment: string;
  variables: Map<string, string>;
}

/**
 * Loads the project's config, unlocks, syncs when the local copy is stale,
 * and reads the environment's variables. Field problems become warnings.
 */
export async function loadVariables(
  context: CliContext,
  options: { env?: string; offline?: boolean },
): Promise<LoadedVariables> {
  const { config } = await loadConfig(context.cwd);
  const environment = resolveEnvironment(config, options.env);
  const { session, status } = await requireSession(context);
  warnOnServerMismatch(context, config, status);

  const backend = context.backend();
  if (!options.offline && needsSync(status.lastSync, syncIntervalFromEnv(context.env))) {
    await backend.sync(session);
  }

  let item;
  try {
    item = await backend.getItem(session, environment.itemId);
  } catch (error) {
    if (error instanceof BwError && error.bwMessage === "Not found.") {
      throw new EnvkitError(`Can't open environment "${environment.name}" (${error.message})`, {
        hint: "Ask an organization admin for access to its collection. If you were just given access, run `envkit sync`.",
      });
    }
    throw error;
  }

  const { variables, warnings } = readVariables(item);
  for (const warning of warnings) context.output.stderr(`warning: ${warning}`);
  return { config, environment: environment.name, variables };
}
