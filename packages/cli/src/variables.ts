import {
  BwError,
  EnvkitError,
  loadConfig,
  needsSync,
  readVariables,
  resolveEnvironment,
  syncIntervalFromEnv,
  type EnvironmentRef,
  type EnvkitConfig,
  type VaultItem,
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

export interface EnvironmentData {
  environment: string;
  ref: EnvironmentRef;
  /** The item as read, including its revisionDate for conflict detection. */
  item: VaultItem;
  variables: Map<string, string>;
}

export interface OpenProject {
  config: EnvkitConfig;
  session: string;
  read(environment?: string): Promise<EnvironmentData>;
}

/**
 * Loads the project's config, unlocks, and syncs: always for writes (`sync:
 * "always"`), otherwise only when the local copy is stale and not offline.
 */
export async function openProject(
  context: CliContext,
  options: { offline?: boolean; sync?: "always" | "when-stale" } = {},
): Promise<OpenProject> {
  const { config } = await loadConfig(context.cwd);
  const { session, status } = await requireSession(context);
  warnOnServerMismatch(context, config, status);

  const backend = context.backend();
  const stale = needsSync(status.lastSync, syncIntervalFromEnv(context.env));
  if (options.sync === "always" || (!options.offline && stale)) await backend.sync(session);

  return {
    config,
    session,
    async read(name) {
      const ref = resolveEnvironment(config, name);
      const item = await getEnvironmentItem(context, session, ref.name, ref.itemId);
      const { variables, warnings } = readVariables(item);
      for (const warning of warnings) context.output.stderr(`warning: ${warning}`);
      return { environment: ref.name, ref, item, variables };
    },
  };
}

/** One environment's variables, for read-only commands. */
export async function loadVariables(
  context: CliContext,
  options: { env?: string; offline?: boolean },
): Promise<EnvironmentData & { config: EnvkitConfig }> {
  const project = await openProject(context, options);
  return { config: project.config, ...(await project.read(options.env)) };
}

async function getEnvironmentItem(
  context: CliContext,
  session: string,
  environment: string,
  itemId: string,
): Promise<VaultItem> {
  try {
    return await context.backend().getItem(session, itemId);
  } catch (error) {
    if (error instanceof BwError && error.bwMessage === "Not found.") {
      throw new EnvkitError(`Can't open environment "${environment}" (${error.message})`, {
        hint: "Ask an organization admin for access to its collection. If you were just given access, run `envkit sync`.",
      });
    }
    throw error;
  }
}
