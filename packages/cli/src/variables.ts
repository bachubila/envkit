import {
  BwError,
  EnvkitError,
  githubMaskCommands,
  isGithubActions,
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
import { cachedSession, isSessionRejected, requireSession, type Session } from "./session.ts";

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
  /** A session `bw` accepted (or, before the first call, the cached one). */
  readonly session: string;
  read(environment?: string): Promise<EnvironmentData>;
}

/**
 * Loads the project's config, unlocks, and syncs: always for writes (`sync:
 * "always"`), otherwise only when the local copy is stale and not offline.
 *
 * With a cached session it skips `bw status` and goes straight to the work,
 * so a warm read is a single `bw` call; if `bw` rejects the session it falls
 * back to checking the status and unlocking, then retries once.
 */
export async function openProject(
  context: CliContext,
  options: { offline?: boolean; sync?: "always" | "when-stale" } = {},
): Promise<OpenProject> {
  const { config } = await loadConfig(context.cwd);
  const backend = context.backend();
  const sessions = await context.sessions();
  const login = { server: config.server };
  const cached = await cachedSession(context);
  let optimistic = cached !== undefined;
  let current: Session = cached ?? (await requireSession(context, login));
  warnOnServerMismatch(context, config, current.status);

  async function withSession<T>(work: (session: string) => Promise<T>): Promise<T> {
    try {
      return await work(current.session);
    } catch (error) {
      if (!optimistic || !isSessionRejected(error)) throw error;
      optimistic = false;
      await sessions.clear();
      current = await requireSession(context, login);
      return work(current.session);
    }
  }

  const stale = needsSync(current.status.lastSync, syncIntervalFromEnv(context.env));
  if (options.sync === "always" || (!options.offline && stale)) {
    await withSession((session) => backend.sync(session));
    await sessions.recordSync();
  }

  return {
    config,
    get session() {
      return current.session;
    },
    async read(name) {
      const ref = resolveEnvironment(config, name);
      const item = await withSession((session) =>
        getEnvironmentItem(context, session, ref.name, ref.itemId),
      );
      const { variables, warnings } = readVariables(item);
      for (const warning of warnings) context.output.stderr(`warning: ${warning}`);
      // Before any value can reach the job log. Workflow commands work on stderr too.
      if (isGithubActions(context.env)) {
        for (const command of githubMaskCommands(variables.values())) {
          context.output.stderr(command);
        }
      }
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
