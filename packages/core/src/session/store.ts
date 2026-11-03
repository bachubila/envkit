export interface StoredSession {
  /** `bw` session key (the BW_SESSION value). */
  key: string;
  serverUrl: string;
  email: string;
  /** Epoch ms after which the session is discarded. */
  expiresAt: number;
}

export interface SessionStore {
  /** Human-readable name for status output, e.g. "OS keychain". */
  readonly description: string;
  /** Whether a saved session outlives the current process. */
  readonly persistent: boolean;
  get(): Promise<StoredSession | undefined>;
  set(session: StoredSession): Promise<void>;
  delete(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly description = "memory (this process only)";
  readonly persistent = false;
  #session: StoredSession | undefined;

  async get(): Promise<StoredSession | undefined> {
    return this.#session;
  }

  async set(session: StoredSession): Promise<void> {
    this.#session = session;
  }

  async delete(): Promise<void> {
    this.#session = undefined;
  }
}

interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/** Stores the session in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service). */
export class KeyringSessionStore implements SessionStore {
  readonly description = "OS keychain";
  readonly persistent = true;
  readonly #entry: KeyringEntry;

  constructor(entry: KeyringEntry) {
    this.#entry = entry;
  }

  async get(): Promise<StoredSession | undefined> {
    const value = await this.#entry.getPassword();
    if (!value) return undefined;
    try {
      return parseStoredSession(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  async set(session: StoredSession): Promise<void> {
    await this.#entry.setPassword(JSON.stringify(session));
  }

  async delete(): Promise<void> {
    await this.#entry.deleteCredential();
  }
}

/**
 * Uses the OS keychain when it works on this machine, otherwise falls back to
 * memory, which means envkit asks for the master password on every command.
 * `account` separates envkit homes (ENVKIT_HOME) from each other.
 */
export async function createSessionStore(account: string): Promise<SessionStore> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const entry = new AsyncEntry("envkit", account);
    // Probe: a missing or locked Secret Service only fails on first use.
    await entry.getPassword();
    return new KeyringSessionStore(entry);
  } catch {
    return new MemorySessionStore();
  }
}

function parseStoredSession(value: unknown): StoredSession | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { key, serverUrl, email, expiresAt } = value as Record<string, unknown>;
  if (
    typeof key !== "string" ||
    typeof serverUrl !== "string" ||
    typeof email !== "string" ||
    typeof expiresAt !== "number"
  ) {
    return undefined;
  }
  return { key, serverUrl, email, expiresAt };
}
