import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { EnvkitError } from "../../errors.ts";
import type { Env } from "../../paths.ts";
import type {
  ApiKeyLoginOptions,
  Collection,
  ItemFilter,
  LoginOptions,
  NewVaultItem,
  Organization,
  OrganizationRole,
  VaultBackend,
  VaultField,
  VaultItem,
  VaultStatus,
} from "../backend.ts";
import { conflictError, toError, trashedError, type VaultError } from "../errors.ts";
import {
  assertStrongKdf,
  DecryptionError,
  decrypt,
  decryptRsa,
  decryptText,
  deriveMasterKey,
  encrypt,
  masterPasswordHash,
  stretchMasterKey,
  type KdfConfig,
} from "./crypto.ts";
import { HttpError, send, type HttpRequest } from "./http.ts";
import {
  StateStore,
  type AccountState,
  type RawCipher,
  type RawCollection,
  type RawField,
  type RawOrganization,
  type State,
  type VaultData,
} from "./state.ts";

export interface NativeBackendOptions {
  /** Where the account, tokens and encrypted vault copy live: `$ENVKIT_HOME/vault`. */
  dataDir: string;
  /** Trusted CA certificates (PEM). Defaults to Node's. */
  ca?: string[];
}

/** Unknown server messages are shown as "vault: <message>". */
const SOURCE = "vault";

/** Refresh the access token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

/**
 * Talks to Vaultwarden's API directly and does the client-side crypto itself,
 * so no `bw` process is involved. Reads come from an encrypted local copy of
 * the vault (refreshed by `sync`); writes go to the server and update the copy.
 */
export class NativeBackend implements VaultBackend {
  readonly #store: StateStore;
  readonly #ca: string[] | undefined;

  constructor(options: NativeBackendOptions) {
    this.#store = new StateStore(options.dataDir);
    this.#ca = options.ca;
  }

  static fromEnv(env: Env, envkitHome: string): NativeBackend {
    return new NativeBackend({ dataDir: join(envkitHome, "vault"), ca: extraCa(env) });
  }

  async status(session?: string): Promise<VaultStatus> {
    const { serverUrl, account } = await this.#store.load();
    if (!account) {
      return {
        state: "unauthenticated",
        serverUrl,
        email: undefined,
        userId: undefined,
        lastSync: undefined,
      };
    }
    return {
      state: unwrapSession(account, session) ? "unlocked" : "locked",
      serverUrl,
      email: account.email,
      userId: account.userId,
      lastSync: account.lastSync ? new Date(account.lastSync) : undefined,
    };
  }

  async setServer(url: string): Promise<void> {
    await this.#store.update((state) => {
      if (state.account) throw vaultError("Logout required before server config update.");
      state.serverUrl = url;
    });
  }

  async login(options: LoginOptions): Promise<string> {
    const { email, password } = options;
    const state = await this.#loggedOut();
    const server = serverOf(state);
    const normalized = email.trim().toLowerCase();
    const prelogin = await this.#send<Prelogin>({
      method: "POST",
      url: `${server}/identity/accounts/prelogin`,
      json: { email: normalized },
    });
    const kdf: KdfConfig = {
      type: prelogin.kdf,
      iterations: prelogin.kdfIterations,
      memory: prelogin.kdfMemory,
      parallelism: prelogin.kdfParallelism,
    };
    assertStrongKdf(kdf);
    const masterKey = await deriveMasterKey(password, normalized, kdf);
    const token = await this.#requestToken(
      state,
      {
        grant_type: "password",
        username: normalized,
        password: masterPasswordHash(masterKey, password),
        scope: "api offline_access",
        client_id: "cli",
      },
      { "auth-email": Buffer.from(normalized).toString("base64url") },
      options,
    );
    const account = accountFromToken(token);
    const userKey = unwrapUserKey(account, masterKey);
    await this.#store.update((current) => (current.account = account));
    await this.sync("");
    return this.#startSession(userKey);
  }

  async loginWithApiKey({ clientId, clientSecret }: ApiKeyLoginOptions): Promise<void> {
    const state = await this.#loggedOut();
    const apiKey = { clientId, clientSecret };
    const token = await this.#requestToken(state, apiKeyGrant(apiKey));
    const account = { ...accountFromToken(token), apiKey };
    await this.#store.update((current) => (current.account = account));
    await this.sync("");
  }

  async unlock(password: string): Promise<string> {
    const { account } = await this.#store.load();
    if (!account) throw vaultError("You are not logged in.");
    const masterKey = await deriveMasterKey(password, account.email, account.kdf);
    return this.#startSession(unwrapUserKey(account, masterKey));
  }

  async lock(): Promise<void> {
    await this.#store.update((state) => {
      if (state.account) delete state.account.sessionUserKey;
    });
  }

  async logout(): Promise<void> {
    await this.#store.update((state) => delete state.account);
    await this.#store.clearVault();
  }

  /** Works while locked, like `bw sync`: the data stays encrypted. */
  async sync(_session: string): Promise<void> {
    const response = await this.#api<SyncResponse>("GET", "/api/sync?excludeDomains=true");
    const profile = response.profile ?? {};
    await this.#store.saveVault({
      organizations: (profile.organizations ?? []).map((org) => ({
        id: org.id,
        name: org.name,
        type: org.type,
        key: org.key ?? null,
        status: org.status,
        enabled: org.enabled,
      })),
      collections: (response.collections ?? []).map((collection) => ({
        id: collection.id,
        organizationId: collection.organizationId,
        name: collection.name,
        readOnly: collection.readOnly,
      })),
      ciphers: response.ciphers ?? [],
    });
    await this.#store.update((state) => {
      if (!state.account) return;
      state.account.lastSync = new Date().toISOString();
      // Rotated keys (e.g. after a password change elsewhere) arrive with the profile.
      if (profile.key) state.account.encryptedUserKey = profile.key;
      if (profile.privateKey) state.account.encryptedPrivateKey = profile.privateKey;
    });
  }

  async listOrganizations(session: string): Promise<Organization[]> {
    const { data } = await this.#unlocked(session);
    return data.organizations
      .filter((org) => org.status === CONFIRMED && org.enabled && org.key)
      .map(({ id, name, type }) => ({ id, name, role: ROLES[type] ?? "custom" }));
  }

  async listCollections(session: string, organizationId?: string): Promise<Collection[]> {
    const vault = await this.#unlocked(session);
    return vault.data.collections
      .filter((collection) => !organizationId || collection.organizationId === organizationId)
      .flatMap((collection) => {
        try {
          const key = vault.organizationKey(collection.organizationId);
          return [{ ...pick(collection), name: decryptText(collection.name, key) }];
        } catch (error) {
          if (error instanceof DecryptionError) return [];
          throw error;
        }
      });
  }

  async createCollection(
    session: string,
    organizationId: string,
    name: string,
  ): Promise<Collection> {
    const vault = await this.#unlocked(session);
    const raw = await this.#api<RawCollection>(
      "POST",
      `/api/organizations/${organizationId}/collections`,
      {
        name: encrypt(name, vault.organizationKey(organizationId)),
        externalId: null,
        groups: [],
        users: [],
      },
    );
    await this.#updateVault((data) => {
      data.collections.push({ id: raw.id, organizationId, name: raw.name, readOnly: false });
    });
    return { id: raw.id, organizationId, name };
  }

  async listItems(session: string, filter: ItemFilter = {}): Promise<VaultItem[]> {
    const vault = await this.#unlocked(session);
    const search = filter.search?.toLowerCase();
    return vault.data.ciphers
      .filter(
        (raw) =>
          !raw.deletedDate &&
          (!filter.organizationId || raw.organizationId === filter.organizationId) &&
          (!filter.collectionId || (raw.collectionIds ?? []).includes(filter.collectionId)),
      )
      .flatMap((raw) => {
        try {
          return [vault.decryptItem(raw)];
        } catch (error) {
          // Like `bw`, skip what this account can't decrypt rather than fail the list.
          if (error instanceof DecryptionError) return [];
          throw error;
        }
      })
      .filter(
        (item) =>
          !search ||
          item.name.toLowerCase().includes(search) ||
          (item.notes ?? "").toLowerCase().includes(search),
      );
  }

  async getItem(session: string, id: string): Promise<VaultItem> {
    const vault = await this.#unlocked(session);
    return vault.decryptItem(findCipher(vault.data, id));
  }

  async createItem(session: string, item: NewVaultItem): Promise<VaultItem> {
    const vault = await this.#unlocked(session);
    const key = item.organizationId ? vault.organizationKey(item.organizationId) : vault.userKey;
    const cipher = {
      type: SECURE_NOTE,
      organizationId: item.organizationId,
      folderId: null,
      favorite: false,
      reprompt: 0,
      key: null,
      secureNote: { type: 0 },
      ...encryptContent(item, key, []),
      encryptedFor: vault.userId,
    };
    const raw = item.organizationId
      ? await this.#api<RawCipher>("POST", "/api/ciphers/create", {
          cipher,
          collectionIds: item.collectionIds,
        })
      : await this.#api<RawCipher>("POST", "/api/ciphers", cipher);
    await this.#saveCipher(raw);
    return vault.decryptItem(raw);
  }

  async updateItem(session: string, item: VaultItem): Promise<VaultItem> {
    const vault = await this.#unlocked(session);
    const current = findCipher(vault.data, item.id);
    // The server checks lastKnownRevisionDate too; checking here first avoids the round trip.
    if (revisionDate(current) !== item.revisionDate) throw conflictError();
    if (current.edit === false) throw vaultError("You do not have permission to edit this item.");
    const key = vault.itemKey(current);
    const request = {
      ...Object.fromEntries(REQUEST_PROPERTIES.map((name) => [name, current[name] ?? null])),
      ...encryptContent(
        item,
        key,
        (current.fields ?? []).map((field) => decryptField(field, key)),
      ),
      lastKnownRevisionDate: current.revisionDate,
      encryptedFor: vault.userId,
    };
    const raw = await this.#api<RawCipher>("PUT", `/api/ciphers/${item.id}`, request);
    await this.#saveCipher(raw);
    return vault.decryptItem(raw);
  }

  async deleteItem(session: string, id: string): Promise<void> {
    const vault = await this.#unlocked(session);
    findCipher(vault.data, id);
    await this.#api("PUT", `/api/ciphers/${id}/delete`);
    await this.#updateVault((data) => {
      const raw = data.ciphers.find((cipher) => cipher.id === id);
      if (raw) raw.deletedDate = new Date().toISOString();
    });
  }

  async #loggedOut(): Promise<State> {
    const state = await this.#store.load();
    if (state.account) throw vaultError(`You are already logged in as ${state.account.email}.`);
    return state;
  }

  async #startSession(userKey: Buffer): Promise<string> {
    const sessionKey = randomBytes(64);
    await this.#store.update((state) => {
      if (state.account) state.account.sessionUserKey = encrypt(userKey, sessionKey);
    });
    return sessionKey.toString("base64");
  }

  /** The decrypted keys for a valid session, plus the local copy of the vault. */
  async #unlocked(session: string): Promise<UnlockedVault> {
    const { account } = await this.#store.load();
    if (!account) throw vaultError("You are not logged in.");
    const userKey = unwrapSession(account, session);
    if (!userKey) throw vaultError("Vault is locked.");
    return new UnlockedVault(userKey, account, await this.#store.loadVault());
  }

  async #updateVault(change: (data: VaultData) => void): Promise<void> {
    const data = await this.#store.loadVault();
    change(data);
    await this.#store.saveVault(data);
  }

  async #saveCipher(raw: RawCipher): Promise<void> {
    await this.#updateVault((data) => {
      const index = data.ciphers.findIndex((cipher) => cipher.id === raw.id);
      if (index === -1) data.ciphers.push(raw);
      else data.ciphers[index] = raw;
    });
  }

  /** An authenticated API call. Refreshes the access token when it's about to expire or the server rejects it. */
  async #api<T = unknown>(method: HttpRequest["method"], path: string, json?: unknown): Promise<T> {
    const state = await this.#store.load();
    if (!state.account) throw vaultError("You are not logged in.");
    let account = state.account;
    if (account.accessTokenExpiresAt - TOKEN_MARGIN_MS < Date.now()) {
      account = await this.#refresh(state, account);
    }
    const call = (token: string) =>
      this.#send<T>({
        method,
        url: `${serverOf(state)}${path}`,
        json,
        headers: { authorization: `Bearer ${token}` },
      });
    try {
      return await call(account.accessToken);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) throw toVaultError(error);
    }
    account = await this.#refresh(state, account);
    try {
      return await call(account.accessToken);
    } catch (error) {
      throw toVaultError(error);
    }
  }

  /**
   * Gets a new access token with the refresh token, or the API key that
   * logged in. If the server refuses both, the login is gone: forget it.
   */
  async #refresh(state: State, account: AccountState): Promise<AccountState> {
    const grant = account.refreshToken
      ? { grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: "cli" }
      : account.apiKey
        ? apiKeyGrant(account.apiKey)
        : undefined;
    let token: TokenResponse | undefined;
    if (grant) {
      try {
        token = await this.#send<TokenResponse>(tokenRequest(state, grant));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
    }
    if (!token?.access_token) {
      await this.logout();
      throw vaultError("You are not logged in.");
    }
    const { access_token, expires_in, refresh_token } = token;
    const refreshed = await this.#store.update((current) => {
      if (!current.account) return;
      current.account.accessToken = access_token;
      current.account.accessTokenExpiresAt = Date.now() + expires_in * 1000;
      if (refresh_token) current.account.refreshToken = refresh_token;
    });
    return refreshed.account ?? account;
  }

  async #requestToken(
    state: State,
    grant: Record<string, string>,
    headers?: Record<string, string>,
    login?: LoginOptions,
  ): Promise<TokenResponse> {
    const emailSent = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send<TokenResponse>(tokenRequest(state, grant, headers));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400 || !error.body) {
          throw toVaultError(error);
        }
        const kind = verificationKind(error.body);
        if (!kind) {
          if (hasTwoFactor(error.body)) {
            throw verificationError(
              "This account requires a two-step method unsupported in a terminal",
            );
          }
          throw toVaultError(error);
        }
        if (!login?.interactive || !login.askCode) {
          throw verificationError(
            kind === "new-device"
              ? "This device needs email verification"
              : "This account uses two-step login",
          );
        }
        if (attempt >= 3) throw verificationError("Login verification failed after three attempts");
        if (kind === "email" && !emailSent.has(kind)) {
          try {
            await this.#send({
              method: "POST",
              url: `${serverOf(state)}/api/two-factor/send-email-login`,
              json: {
                email: grant.username,
                masterPasswordHash: grant.password,
                deviceIdentifier: state.deviceId,
              },
            });
          } catch (sendError) {
            throw toVaultError(sendError);
          }
          emailSent.add(kind);
        }
        const code = (await login.askCode(kind)).trim();
        if (!code) throw verificationError("No login verification code supplied");
        if (kind === "new-device") grant.newDeviceOtp = code;
        else {
          grant.twoFactorToken = code;
          grant.twoFactorProvider = kind === "authenticator" ? "0" : "1";
          grant.twoFactorRemember = "0";
        }
      }
    }
  }

  #send<T>(request: HttpRequest): Promise<T> {
    return send<T>({ ...request, headers: { ...CLIENT_HEADERS, ...request.headers } }, this.#ca);
  }
}

/** Keys of an unlocked vault, with the decryption helpers that need them. */
class UnlockedVault {
  readonly userKey: Buffer;
  readonly data: VaultData;
  /** Vaultwarden requires it on writes ("encryptedFor"): the user whose keys encrypted the item. */
  readonly userId: string;
  readonly #account: AccountState;
  readonly #organizationKeys = new Map<string, Buffer>();
  #privateKey: Buffer | undefined;

  constructor(userKey: Buffer, account: AccountState, data: VaultData) {
    this.userKey = userKey;
    this.userId = account.userId;
    this.#account = account;
    this.data = data;
  }

  organizationKey(organizationId: string): Buffer {
    let key = this.#organizationKeys.get(organizationId);
    if (!key) {
      const encrypted = this.data.organizations.find((org) => org.id === organizationId)?.key;
      if (!encrypted) throw new DecryptionError(`No key for organization ${organizationId}`);
      this.#privateKey ??= decrypt(this.#account.encryptedPrivateKey, this.userKey);
      key = decryptRsa(encrypted, this.#privateKey);
      this.#organizationKeys.set(organizationId, key);
    }
    return key;
  }

  /** The key an item's contents are encrypted with: its own key, or its owner's. */
  itemKey(raw: RawCipher): Buffer {
    const owner = raw.organizationId ? this.organizationKey(raw.organizationId) : this.userKey;
    return raw.key ? decrypt(raw.key, owner) : owner;
  }

  decryptItem(raw: RawCipher): VaultItem {
    const key = this.itemKey(raw);
    return {
      id: raw.id,
      organizationId: raw.organizationId ?? null,
      collectionIds: raw.collectionIds ?? [],
      name: decryptText(raw.name, key),
      notes: raw.notes ? decryptText(raw.notes, key) : null,
      fields: (raw.fields ?? []).map((field) => {
        const { name, value, type } = decryptField(field, key);
        return { name, value, type };
      }),
      revisionDate: revisionDate(raw),
    };
  }
}

function decryptField(field: RawField, key: Buffer): VaultField & { linkedId?: number | null } {
  return {
    name: field.name ? decryptText(field.name, key) : "",
    value: field.value ? decryptText(field.value, key) : null,
    type: field.type as VaultField["type"],
    linkedId: field.linkedId ?? null,
  };
}

/** Name, notes and fields encrypted for a request. Linked fields keep their target. */
function encryptContent(
  item: Pick<VaultItem, "name" | "notes" | "fields">,
  key: Buffer,
  currentFields: (VaultField & { linkedId?: number | null })[],
) {
  return {
    name: encrypt(item.name, key),
    notes: item.notes === null ? null : encrypt(item.notes, key),
    fields: item.fields.map((field) => ({
      name: encrypt(field.name, key),
      value: field.value === null ? null : encrypt(field.value, key),
      type: field.type,
      linkedId:
        currentFields.find((current) => current.name === field.name && current.type === field.type)
          ?.linkedId ?? null,
    })),
  };
}

/** Millisecond precision, as `bw` reports it; the server stores microseconds. */
function revisionDate(raw: RawCipher): string {
  return new Date(raw.revisionDate).toISOString();
}

function findCipher(data: VaultData, id: string): RawCipher {
  const raw = data.ciphers.find((cipher) => cipher.id === id);
  if (!raw) throw vaultError("Not found.");
  if (raw.deletedDate) throw trashedError();
  return raw;
}

function unwrapUserKey(account: AccountState, masterKey: Buffer): Buffer {
  try {
    // Type 0 is the legacy format, encrypted with the unstretched master key.
    return account.encryptedUserKey.startsWith("0.")
      ? decrypt(account.encryptedUserKey, masterKey)
      : decrypt(account.encryptedUserKey, stretchMasterKey(masterKey));
  } catch (error) {
    if (error instanceof DecryptionError) throw vaultError("Invalid master password.");
    throw error;
  }
}

function unwrapSession(account: AccountState, session: string | undefined): Buffer | undefined {
  if (!session || !account.sessionUserKey) return undefined;
  const sessionKey = Buffer.from(session, "base64");
  if (sessionKey.length !== 64) return undefined;
  try {
    return decrypt(account.sessionUserKey, sessionKey);
  } catch (error) {
    if (error instanceof DecryptionError) return undefined;
    throw error;
  }
}

function accountFromToken(token: TokenResponse): AccountState {
  const claims = jwtClaims(token.access_token);
  return {
    userId: typeof claims.sub === "string" ? claims.sub : "",
    email: typeof claims.email === "string" ? claims.email.toLowerCase() : "",
    kdf: {
      type: token.Kdf,
      iterations: token.KdfIterations,
      memory: token.KdfMemory,
      parallelism: token.KdfParallelism,
    },
    encryptedUserKey: token.Key,
    encryptedPrivateKey: token.PrivateKey,
    accessToken: token.access_token,
    accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
  };
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function tokenRequest(
  state: State,
  grant: Record<string, string>,
  headers?: Record<string, string>,
): HttpRequest {
  return {
    method: "POST",
    url: `${serverOf(state)}/identity/connect/token`,
    form: {
      ...grant,
      deviceType: DEVICE_TYPE,
      deviceIdentifier: state.deviceId,
      deviceName: "envkit",
    },
    headers,
  };
}

function apiKeyGrant(apiKey: { clientId: string; clientSecret: string }): Record<string, string> {
  return {
    grant_type: "client_credentials",
    client_id: apiKey.clientId,
    client_secret: apiKey.clientSecret,
    scope: "api",
  };
}

function hasTwoFactor(body: Record<string, unknown>): boolean {
  return "TwoFactorProviders" in body || "TwoFactorProviders2" in body;
}

function verificationKind(
  body: Record<string, unknown>,
): "authenticator" | "email" | "new-device" | undefined {
  const providers = body.TwoFactorProviders2;
  const keys =
    providers && typeof providers === "object" && !Array.isArray(providers)
      ? Object.keys(providers)
      : Array.isArray(body.TwoFactorProviders)
        ? body.TwoFactorProviders.map(String)
        : [];
  if (keys.includes("0")) return "authenticator";
  if (keys.includes("1")) return "email";
  const model = body.ErrorModel ?? body.errorModel;
  if (
    model &&
    typeof model === "object" &&
    "Message" in model &&
    model.Message === "new device verification required"
  )
    return "new-device";
  return undefined;
}

function verificationError(message: string): EnvkitError {
  return new EnvkitError(message, {
    hint: "Use `envkit login --apikey` with BW_CLIENTID and BW_CLIENTSECRET, or set ENVKIT_BACKEND=bw for the Bitwarden CLI.",
  });
}

function serverOf(state: State): string {
  if (!state.serverUrl) {
    throw new EnvkitError("No vault server configured", {
      hint: "Run `envkit login --server <url>`.",
    });
  }
  return state.serverUrl;
}

function vaultError(message: string): VaultError {
  return toError(message, undefined, SOURCE);
}

function toVaultError(error: unknown): unknown {
  return error instanceof HttpError ? vaultError(error.message) : error;
}

function pick({ id, organizationId, name }: RawCollection): Collection {
  return { id, organizationId, name };
}

/**
 * Trust NODE_EXTRA_CA_CERTS from `env` even when it isn't this process's
 * environment (Node reads it only at startup). Undefined keeps Node's defaults.
 */
function extraCa(env: Env): string[] | undefined {
  const path = env.NODE_EXTRA_CA_CERTS;
  if (!path || path === process.env.NODE_EXTRA_CA_CERTS) return undefined;
  try {
    return [...rootCertificates, readFileSync(path, "utf8")];
  } catch {
    return undefined;
  }
}

// Bitwarden's DeviceType: WindowsCLI, MacOsCLI, LinuxCLI.
const DEVICE_TYPE =
  process.platform === "win32" ? "23" : process.platform === "darwin" ? "24" : "25";

/**
 * Bitwarden's own servers reject requests without these ("No client version header
 * found"); Vaultwarden ignores them. envkit identifies as the CLI it speaks the
 * protocol of, at a version recent enough for the server's feature checks.
 */
const CLIENT_HEADERS: Record<string, string> = {
  "Bitwarden-Client-Name": "cli",
  "Bitwarden-Client-Version": "2026.10.0",
  "Device-Type": DEVICE_TYPE,
};

const SECURE_NOTE = 2;

// OrganizationUserStatusType.Confirmed: invited or accepted members have no key yet.
const CONFIRMED = 2;

// Bitwarden's OrganizationUserType.
const ROLES: Record<number, OrganizationRole> = {
  0: "owner",
  1: "admin",
  2: "user",
  3: "manager",
  4: "custom",
};

/** Cipher properties sent back unchanged on update, so envkit never drops data it doesn't manage. */
const REQUEST_PROPERTIES = [
  "type",
  "organizationId",
  "folderId",
  "favorite",
  "reprompt",
  "key",
  "login",
  "card",
  "identity",
  "secureNote",
  "sshKey",
  "passwordHistory",
] as const;

interface Prelogin {
  kdf: number;
  kdfIterations: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  Key: string;
  PrivateKey: string;
  Kdf: number;
  KdfIterations: number;
  KdfMemory?: number | null;
  KdfParallelism?: number | null;
}

interface SyncResponse {
  profile?: {
    key?: string;
    privateKey?: string;
    organizations?: (RawOrganization & { key?: string | null })[];
  };
  collections?: RawCollection[];
  ciphers?: RawCipher[];
}
