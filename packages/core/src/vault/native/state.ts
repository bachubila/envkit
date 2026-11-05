import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KdfConfig } from "./crypto.ts";

/** The logged-in account. Keys stay encrypted: with the master key, or with the session key. */
export interface AccountState {
  userId: string;
  email: string;
  kdf: KdfConfig;
  /** The user key encrypted with the stretched master key, as the server sends it. */
  encryptedUserKey: string;
  /** The RSA private key (PKCS#8 DER) encrypted with the user key. */
  encryptedPrivateKey: string;
  accessToken: string;
  /** Epoch ms. */
  accessTokenExpiresAt: number;
  refreshToken?: string;
  /** API-key logins get no refresh token; the key itself gets a new access token. */
  apiKey?: { clientId: string; clientSecret: string };
  /**
   * The user key encrypted with the current session key, written by unlock.
   * Unlocking again replaces it, which invalidates older sessions, as with `bw`.
   */
  sessionUserKey?: string;
  /** ISO date of the last full sync. */
  lastSync?: string;
}

export interface State {
  serverUrl?: string;
  /** Stable per envkit home, so the server sees one device rather than one per login. */
  deviceId: string;
  account?: AccountState;
}

/** The parts of `/api/sync` envkit uses. Names and values stay encrypted. */
export interface VaultData {
  organizations: RawOrganization[];
  collections: RawCollection[];
  ciphers: RawCipher[];
}

export interface RawOrganization {
  id: string;
  name: string;
  type: number;
  /** The organization key encrypted with the user's public key. */
  key: string | null;
  status: number;
  enabled: boolean;
}

export interface RawCollection {
  id: string;
  organizationId: string;
  name: string;
  readOnly?: boolean;
}

export interface RawField {
  name: string | null;
  value: string | null;
  type: number;
  linkedId?: number | null;
}

/** A cipher as the server returns it. Unknown properties are kept so updates don't drop them. */
export interface RawCipher {
  id: string;
  type: number;
  organizationId: string | null;
  collectionIds: string[];
  name: string;
  notes: string | null;
  fields: RawField[] | null;
  /** A per-item key, encrypted with the user or organization key. */
  key: string | null;
  revisionDate: string;
  deletedDate: string | null;
  [property: string]: unknown;
}

/**
 * envkit's own vault client state, in `$ENVKIT_HOME/vault`. Files are written
 * with mode 600 and replaced atomically, so a crash never leaves half a file.
 */
export class StateStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async load(): Promise<State> {
    const state = await this.#read<State>("state.json");
    return state?.deviceId ? state : { deviceId: randomUUID() };
  }

  async save(state: State): Promise<void> {
    await this.#write("state.json", state);
  }

  /**
   * Re-reads the state, applies `change` and saves it. Changes made by
   * another envkit process since this one loaded the state are kept.
   */
  async update(change: (state: State) => void): Promise<State> {
    const state = await this.load();
    change(state);
    await this.save(state);
    return state;
  }

  async loadVault(): Promise<VaultData> {
    return (
      (await this.#read<VaultData>("vault.json")) ?? {
        organizations: [],
        collections: [],
        ciphers: [],
      }
    );
  }

  async saveVault(data: VaultData): Promise<void> {
    await this.#write("vault.json", data);
  }

  async clearVault(): Promise<void> {
    await rm(join(this.#dir, "vault.json"), { force: true });
  }

  async #read<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.#dir, name), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async #write(name: string, value: unknown): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, name);
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  }
}
