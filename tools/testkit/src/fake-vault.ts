import {
  BwError,
  canCreateCollections,
  CONFLICT_MESSAGE,
  toError,
  type ApiKeyLoginOptions,
  type Collection,
  type ItemFilter,
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
  /** Reported by `status`; set it to make envkit consider the local copy fresh. */
  lastSync: Date | undefined;
  /** Every method call, in order, for assertions. */
  readonly calls: string[] = [];
  #session: string | undefined;
  #sessionCounter = 0;
  #itemCounter = 0;
  #revisionCounter = 0;

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
      lastSync: this.lastSync,
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
    this.calls.push("sync");
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

  async createCollection(
    session: string,
    organizationId: string,
    name: string,
  ): Promise<Collection> {
    this.#requireSession(session);
    this.calls.push(`createCollection ${name}`);
    const organization = this.organizations.find((org) => org.id === organizationId);
    if (!organization) throw toError("Organization not found.");
    if (!canCreateCollections(organization)) {
      // What really happens: Vaultwarden returns 401 and `bw` logs the user out.
      this.account = undefined;
      this.#session = undefined;
      throw toError('{"response":{"error":{"code":401,"reason":"Unauthorized"}},"statusCode":401}');
    }
    const collection = { id: `collection-${this.collections.length + 1}`, organizationId, name };
    this.collections.push(collection);
    return collection;
  }

  async listItems(session: string, filter: ItemFilter = {}): Promise<VaultItem[]> {
    this.#requireSession(session);
    const search = filter.search?.toLowerCase();
    return [...this.items.values()]
      .filter(
        (item) =>
          (!filter.organizationId || item.organizationId === filter.organizationId) &&
          (!filter.collectionId || item.collectionIds.includes(filter.collectionId)) &&
          (!search ||
            item.name.toLowerCase().includes(search) ||
            (item.notes ?? "").toLowerCase().includes(search)),
      )
      .map((item) => structuredClone(item));
  }

  async getItem(session: string, id: string): Promise<VaultItem> {
    this.#requireSession(session);
    const item = this.items.get(id);
    if (!item) throw toError("Not found.");
    return structuredClone(item);
  }

  async createItem(session: string, item: NewVaultItem): Promise<VaultItem> {
    this.#requireSession(session);
    this.calls.push(`createItem ${item.name}`);
    const created = {
      ...structuredClone(item),
      id: `item-${++this.#itemCounter}`,
      revisionDate: this.#nextRevision(),
    };
    this.items.set(created.id, created);
    return structuredClone(created);
  }

  async updateItem(session: string, item: VaultItem): Promise<VaultItem> {
    this.#requireSession(session);
    const current = this.items.get(item.id);
    if (!current) throw toError("Not found.");
    this.calls.push(`updateItem ${item.name}`);
    if (current.revisionDate !== item.revisionDate) {
      throw new BwError("conflict", CONFLICT_MESSAGE, "Run the command again.");
    }
    const updated = { ...structuredClone(item), revisionDate: this.#nextRevision() };
    this.items.set(item.id, updated);
    return structuredClone(updated);
  }

  async deleteItem(session: string, id: string): Promise<void> {
    this.#requireSession(session);
    this.calls.push(`deleteItem ${id}`);
    if (!this.items.delete(id)) throw toError("Not found.");
  }

  /** Test helper: an edit by someone else, as seen after a sync. */
  editElsewhere(id: string, edit: (item: VaultItem) => void): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`FakeVault: no item ${id}`);
    edit(item);
    item.revisionDate = this.#nextRevision();
  }

  // Strictly increasing, unlike Date.now(), which repeats within a millisecond.
  #nextRevision(): string {
    return new Date(Date.UTC(2026, 0, 1) + ++this.#revisionCounter * 1000).toISOString();
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
