import { BwError, EnvkitError, normalizeServerUrl, type VaultStatus } from "@envkit/core";
import type { CliContext } from "./context.ts";

const MAX_PASSWORD_ATTEMPTS = 3;

export interface Session {
  session: string;
  status: VaultStatus;
}

export interface LoginOptions {
  /** Server to log in to automatically when ENVKIT_SERVER isn't set, e.g. the project's. */
  server?: string;
}

/**
 * Logged-in status, or a "run `envkit login`" error. Without a terminal it
 * logs in from BW_CLIENTID/BW_CLIENTSECRET or ENVKIT_EMAIL/ENVKIT_PASSWORD.
 */
export async function requireLogin(
  context: CliContext,
  options: LoginOptions = {},
): Promise<VaultStatus> {
  return (await loginState(context, options)).status;
}

/**
 * A session key that is valid right now: ENVKIT_SESSION, then the cached
 * session, then unlocking with the master password. Costs one `bw status`.
 */
export async function requireSession(
  context: CliContext,
  options: LoginOptions = {},
): Promise<Session> {
  const fromEnv = context.env.ENVKIT_SESSION;
  const sessions = await context.sessions();
  const cached = fromEnv ? undefined : await sessions.peek();
  const state = await loginState(context, { ...options, session: fromEnv ?? cached?.key });
  if (state.session) return { session: state.session, status: state.status };

  const { status } = state;
  if (status.state === "unlocked") {
    if (fromEnv) return { session: fromEnv, status };
    if (cached && cached.serverUrl === status.serverUrl && cached.email === status.email) {
      await sessions.save(cached.key, status);
      return { session: cached.key, status };
    }
  }
  // `bw lock`, a newer unlock elsewhere or an account switch invalidated it.
  if (cached) await sessions.clear();
  return { session: await unlockVault(context, status), status };
}

/**
 * The cached session as it was last seen, without asking `bw`. Commands that
 * use it must fall back to `requireSession` when `bw` rejects it (see
 * `isSessionRejected`). Saves the two `bw status` calls (~3 s) on warm reads.
 */
export async function cachedSession(context: CliContext): Promise<Session | undefined> {
  if (context.env.ENVKIT_SESSION) return undefined;
  const stored = await (await context.sessions()).peek();
  if (!stored) return undefined;
  return {
    session: stored.key,
    status: {
      state: "unlocked",
      serverUrl: stored.serverUrl,
      email: stored.email,
      userId: undefined,
      lastSync: stored.lastSync === undefined ? undefined : new Date(stored.lastSync),
    },
  };
}

/** Whether `bw` refused a command because the session is no longer valid. */
export function isSessionRejected(error: unknown): boolean {
  return (
    error instanceof BwError && /^(Vault is locked|You are not logged in)/.test(error.bwMessage)
  );
}

async function loginState(
  context: CliContext,
  options: LoginOptions & { session?: string | undefined },
): Promise<{ status: VaultStatus; session?: string }> {
  const backend = context.backend();
  const status = await backend.status(options.session);
  if (status.state !== "unauthenticated") return { status };
  const loggedIn = await loginFromEnv(context, options.server);
  if (loggedIn) return loggedIn;
  throw new EnvkitError("Not logged in", {
    hint: context.interactive
      ? "Run `envkit login`."
      : "Run `envkit login`, or set BW_CLIENTID and BW_CLIENTSECRET (or ENVKIT_EMAIL) with ENVKIT_PASSWORD to log in automatically.",
  });
}

/**
 * Logs in without prompting when there's no terminal (CI) and the env has
 * credentials: an API key, or an email and master password.
 */
async function loginFromEnv(
  context: CliContext,
  projectServer: string | undefined,
): Promise<{ status: VaultStatus; session?: string } | undefined> {
  const { env } = context;
  if (context.interactive) return undefined;
  const requested = env.ENVKIT_SERVER ?? projectServer;
  const apiKey = env.BW_CLIENTID && env.BW_CLIENTSECRET;
  const password = env.ENVKIT_EMAIL && env.ENVKIT_PASSWORD !== undefined;
  if (!requested || !(apiKey || password)) return undefined;

  const backend = context.backend();
  const serverUrl = normalizeServerUrl(requested);
  if ((await backend.status()).serverUrl !== serverUrl) await backend.setServer(serverUrl);
  let session: string | undefined;
  if (env.BW_CLIENTID && env.BW_CLIENTSECRET) {
    await backend.loginWithApiKey({ clientId: env.BW_CLIENTID, clientSecret: env.BW_CLIENTSECRET });
  } else {
    session = await backend.login({
      email: (env.ENVKIT_EMAIL ?? "").trim().toLowerCase(),
      password: env.ENVKIT_PASSWORD ?? "",
      interactive: false,
    });
  }
  const status = await backend.status(session);
  if (session) await (await context.sessions()).save(session, status);
  context.output.stderr(`Logged in as ${status.email} on ${status.serverUrl}.`);
  return session ? { status, session } : { status };
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
