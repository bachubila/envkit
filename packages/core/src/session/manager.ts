import type { VaultStatus } from "../vault/backend.ts";
import type { SessionStore } from "./store.ts";

export const DEFAULT_SESSION_IDLE_MINUTES = 60;

export interface SessionManagerOptions {
  /** Idle timeout: each successful use pushes expiry this far out. */
  idleTimeoutMs?: number;
  now?: () => number;
}

/**
 * Hands out the cached session key for the account `bw` is logged into, and
 * forgets it once it has been idle too long or belongs to another account.
 */
export class SessionManager {
  readonly store: SessionStore;
  readonly idleTimeoutMs: number;
  readonly #now: () => number;

  constructor(store: SessionStore, options: SessionManagerOptions = {}) {
    this.store = store;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_MINUTES * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The session key for `status`'s account, if one is cached and still fresh.
   * Using it pushes the expiry out again unless `touch` is false.
   */
  async get(
    status: VaultStatus,
    { touch = true }: { touch?: boolean } = {},
  ): Promise<string | undefined> {
    const stored = await this.store.get();
    if (!stored) return undefined;
    if (
      stored.expiresAt <= this.#now() ||
      stored.serverUrl !== status.serverUrl ||
      stored.email !== status.email
    ) {
      await this.store.delete();
      return undefined;
    }
    if (touch) await this.store.set({ ...stored, expiresAt: this.#now() + this.idleTimeoutMs });
    return stored.key;
  }

  async save(key: string, status: VaultStatus): Promise<void> {
    if (!status.serverUrl || !status.email) return;
    await this.store.set({
      key,
      serverUrl: status.serverUrl,
      email: status.email,
      expiresAt: this.#now() + this.idleTimeoutMs,
    });
  }

  async expiresAt(): Promise<Date | undefined> {
    const stored = await this.store.get();
    return stored ? new Date(stored.expiresAt) : undefined;
  }

  async clear(): Promise<void> {
    await this.store.delete();
  }
}

/** Reads ENVKIT_SESSION_IDLE_MINUTES; invalid or missing values use the default. */
export function idleTimeoutFromEnv(env: Record<string, string | undefined>): number {
  const minutes = Number(env.ENVKIT_SESSION_IDLE_MINUTES);
  return (
    (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SESSION_IDLE_MINUTES) * 60_000
  );
}
