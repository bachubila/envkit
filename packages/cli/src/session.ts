import { BwError, EnvkitError, type VaultStatus } from "@envkit/core";
import type { CliContext } from "./context.ts";

const MAX_PASSWORD_ATTEMPTS = 3;

/** Logged-in status, or a "run `envkit login`" error. */
export async function requireLogin(context: CliContext): Promise<VaultStatus> {
  const status = await context.backend().status();
  if (status.state === "unauthenticated") {
    throw new EnvkitError("Not logged in", { hint: "Run `envkit login`." });
  }
  return status;
}

/**
 * A session key that is valid right now: ENVKIT_SESSION, then the cached
 * session, then unlocking with the master password.
 */
export async function requireSession(
  context: CliContext,
): Promise<{ session: string; status: VaultStatus }> {
  const status = await requireLogin(context);
  const existing = await currentSession(context, status);
  if (existing) return { session: existing, status };
  return { session: await unlockVault(context, status), status };
}

/** The usable session key for `status`'s account, if any, without prompting. */
export async function currentSession(
  context: CliContext,
  status: VaultStatus,
  options: { touch?: boolean } = {},
): Promise<string | undefined> {
  const backend = context.backend();
  const fromEnv = context.env.ENVKIT_SESSION;
  if (fromEnv && (await backend.status(fromEnv)).state === "unlocked") return fromEnv;

  const sessions = await context.sessions();
  const cached = await sessions.get(status, options);
  if (!cached) return undefined;
  if ((await backend.status(cached)).state === "unlocked") return cached;
  // `bw lock` or a newer unlock elsewhere invalidated it.
  await sessions.clear();
  return undefined;
}

/** Unlocks with ENVKIT_PASSWORD or a prompt (retrying typos), and caches the session. */
export async function unlockVault(context: CliContext, status: VaultStatus): Promise<string> {
  const backend = context.backend();
  const sessions = await context.sessions();
  const fromEnv = context.env.ENVKIT_PASSWORD;
  if (fromEnv !== undefined) {
    const session = await backend.unlock(fromEnv);
    await sessions.save(session, status);
    return session;
  }
  if (!context.interactive) {
    throw new EnvkitError("Vault is locked", {
      hint: "Run `envkit unlock` in a terminal, or set ENVKIT_PASSWORD.",
    });
  }
  for (let attempt = 1; ; attempt++) {
    const password = await context.prompt.password(`Master password for ${status.email}`);
    try {
      const session = await backend.unlock(password);
      await sessions.save(session, status);
      return session;
    } catch (error) {
      const wrongPassword =
        error instanceof BwError && error.message === "Incorrect master password";
      if (!wrongPassword || attempt >= MAX_PASSWORD_ATTEMPTS) throw error;
      context.output.stderr("Incorrect master password, try again.");
    }
  }
}

/** One line describing how long the unlocked session lasts. */
export async function sessionNote(context: CliContext): Promise<string> {
  const sessions = await context.sessions();
  if (!sessions.store.persistent) {
    return "No OS keychain available, so envkit will ask for your master password on each command.";
  }
  const minutes = Math.round(sessions.idleTimeoutMs / 60_000);
  return `The session is kept in the ${sessions.store.description} and locks after ${minutes} minutes of inactivity.`;
}
