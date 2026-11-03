import {
  toError,
  type ApiKeyLoginOptions,
  type Collection,
  type LoginOptions,
  type NewVaultItem,
  type Organization,
  type VaultBackend,
  type VaultItem,
  type VaultStatus,
} from "@envkit/core";

export interface FakeAccount {
  email: string;
  password: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * In-memory VaultBackend that follows `bw`'s rules (one account per data dir,
 * a new unlock invalidates older sessions, server changes need a logout) and
 * throws the same errors the real backend maps them to.
 */
export class FakeVault implements VaultBackend {
  readonly accounts: FakeAccount[];
  serverUrl: string | undefined;
  account: FakeAccount | undefined;
  organizations: Organization[] = [];
  collections: Collection[] = [];
  items = new Map<string, VaultItem>();
  /** Every method call, in order, for assertions. */
  readonly calls: string[] = [];
  #session: string | undefined;
  #sessionCounter = 0;

  constructor(accounts: FakeAccount[] = []) {
    this.accounts = accounts;
  }

  /** Test helper: start out logged in (and optionally unlocked, returning the session). */
  seedLogin(serverUrl: string, email: string, { unlocked = false } = {}): string | undefined {
    this.serverUrl = serverUrl;
    this.account = this.#find(email);
    return unlocked ? this.#newSession() : undefined;
  }

  async status(session?: string): Promise<VaultStatus> {
    this.calls.push("status");
    return {
      state: !this.account ? "unauthenticated" : this.#isValid(session) ? "unlocked" : "locked",
      serverUrl: this.serverUrl,
      email: this.account?.email,
      userId: this.account ? `user-${this.account.email}` : undefined,
      lastSync: undefined,
    };
  }

  async setServer(url: string): Promise<void> {
    this.calls.push(`setServer ${url}`);
    if (this.account) throw toError("Logout required before server config update.");
    this.serverUrl = url;
  }

  async login({ email, password }: LoginOptions): Promise<string> {
    this.calls.push(`login ${email}`);
    if (this.account) throw toError(`You are already logged in as ${this.account.email}.`);
    const account = this.accounts.find((candidate) => candidate.email === email);
    if (!account || account.password !== password) {
      throw toError("Username or password is incorrect. Try again");
    }
    this.account = account;
    return this.#newSession();
  }

  async loginWithApiKey({ clientId, clientSecret }: ApiKeyLoginOptions): Promise<void> {
    this.calls.push("loginWithApiKey");
    const account = this.accounts.find(
      (candidate) => candidate.clientId === clientId && candidate.clientSecret === clientSecret,
    );
    if (!account) throw toError("client_id or client_secret is incorrect. Try again.");
    this.account = account;
  }

  async unlock(password: string): Promise<string> {
    this.calls.push("unlock");
    if (!this.account) throw toError("You are not logged in.");
    if (password !== this.account.password) {
      throw toError("Cryptography error, The decryption operation failed");
    }
    return this.#newSession();
  }

  async lock(): Promise<void> {
    this.calls.push("lock");
    this.#session = undefined;
  }

  async logout(): Promise<void> {
    this.calls.push("logout");
    this.account = undefined;
    this.#session = undefined;
  }

  // Like `bw sync`: needs a login, not an unlocked vault.
  async sync(_session: string): Promise<void> {
    if (!this.account) throw toError("You are not logged in.");
  }

  async listOrganizations(session: string): Promise<Organization[]> {
    this.#requireSession(session);
    return this.organizations;
  }

  async listCollections(session: string, organizationId?: string): Promise<Collection[]> {
    this.#requireSession(session);
    return this.collections.filter(
      (collection) => !organizationId || collection.organizationId === organizationId,
    );
  }

  async getItem(session: string, id: string): Promise<VaultItem> {
    this.#requireSession(session);
    const item = this.items.get(id);
    if (!item) throw toError("Not found.");
    return structuredClone(item);
  }

  async createItem(session: string, item: NewVaultItem): Promise<VaultItem> {
    this.#requireSession(session);
    const created = {
      ...structuredClone(item),
      id: `item-${this.items.size + 1}`,
      revisionDate: now(),
    };
    this.items.set(created.id, created);
    return structuredClone(created);
  }

  async updateItem(session: string, item: VaultItem): Promise<VaultItem> {
    this.#requireSession(session);
    if (!this.items.has(item.id)) throw toError("Not found.");
    const updated = { ...structuredClone(item), revisionDate: now() };
    this.items.set(item.id, updated);
    return structuredClone(updated);
  }

  #find(email: string): FakeAccount {
    const account = this.accounts.find((candidate) => candidate.email === email);
    if (!account) throw new Error(`FakeVault: no account ${email}`);
    return account;
  }

  #newSession(): string {
    this.#session = `session-${++this.#sessionCounter}`;
    return this.#session;
  }

  #isValid(session: string | undefined): boolean {
    return session !== undefined && session === this.#session;
  }

  #requireSession(session: string): void {
    if (!this.account) throw toError("You are not logged in.");
    if (!this.#isValid(session)) throw toError("Vault is locked.");
  }
}

function now(): string {
  return new Date().toISOString();
}
