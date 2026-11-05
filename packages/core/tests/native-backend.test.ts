import { constants, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { FieldType, NativeBackend, VaultError } from "../src/index.ts";
import { deriveMasterKey, encrypt, KdfType, stretchMasterKey } from "../src/vault/native/crypto.ts";
import type { RawCipher, State, VaultData } from "../src/vault/native/state.ts";

// Everything here works offline: a vault written to disk the way a sync
// would, then read back. Network paths are covered by the integration tests.

const SERVER = "https://vault.test";
const PASSWORD = "correct horse";
const EMAIL = "alice@example.test";
const ORG = "org-1";
const kdf = { type: KdfType.Pbkdf2, iterations: 1000 };

let home: string;
let backend: NativeBackend;
let userKey: Buffer;
let orgKey: Buffer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "envkit-native-"));
  backend = NativeBackend.fromEnv({}, home);
});

afterEach(() => rm(home, { recursive: true, force: true }));

/** Writes a logged-in, locked account with an organization and the given items. */
async function seed(ciphers: (keys: { userKey: Buffer; orgKey: Buffer }) => RawCipher[]) {
  userKey = randomBytes(64);
  orgKey = randomBytes(64);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, kdf);
  const state: State = {
    serverUrl: SERVER,
    deviceId: "device-1",
    account: {
      userId: "user-1",
      email: EMAIL,
      kdf,
      encryptedUserKey: encrypt(userKey, stretchMasterKey(masterKey)),
      encryptedPrivateKey: encrypt(privateKey.export({ type: "pkcs8", format: "der" }), userKey),
      accessToken: "token",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      lastSync: "2026-01-02T03:04:05.000Z",
    },
  };
  const wrappedOrgKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    orgKey,
  );
  const data: VaultData = {
    organizations: [
      {
        id: ORG,
        name: "Acme",
        type: 2,
        key: `4.${wrappedOrgKey.toString("base64")}`,
        status: 2,
        enabled: true,
      },
      { id: "org-invited", name: "Pending", type: 2, key: null, status: 0, enabled: true },
    ],
    collections: [{ id: "col-1", organizationId: ORG, name: encrypt("myapp", orgKey) }],
    ciphers: ciphers({ userKey, orgKey }),
  };
  await writeJson("state.json", state);
  await writeJson("vault.json", data);
}

function cipher(
  key: Buffer,
  overrides: Partial<RawCipher> & { id: string; plainName: string },
): RawCipher {
  const { plainName, ...rest } = overrides;
  return {
    type: 2,
    organizationId: ORG,
    collectionIds: ["col-1"],
    name: encrypt(plainName, key),
    notes: null,
    fields: [],
    key: null,
    revisionDate: "2026-01-02T03:04:05.123456Z",
    deletedDate: null,
    ...rest,
  };
}

async function writeJson(name: string, value: unknown) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "vault"), { recursive: true });
  await writeFile(join(home, "vault", name), JSON.stringify(value));
}

describe("NativeBackend (offline)", () => {
  test("starts logged out, and remembers the server", async () => {
    expect(await backend.status()).toEqual({
      state: "unauthenticated",
      serverUrl: undefined,
      email: undefined,
      userId: undefined,
      lastSync: undefined,
    });
    await backend.setServer(SERVER);
    expect((await backend.status()).serverUrl).toBe(SERVER);
    const state = join(home, "vault", "state.json");
    expect((await stat(state)).mode & 0o777).toBe(0o600);
  });

  test("unlock checks the password and returns a session only this state accepts", async () => {
    await seed(() => []);
    expect(await backend.status()).toMatchObject({ state: "locked", email: EMAIL });
    await expect(backend.unlock("wrong")).rejects.toMatchObject({
      message: "Incorrect master password",
    });
    const session = await backend.unlock(PASSWORD);
    expect(Buffer.from(session, "base64")).toHaveLength(64);
    expect(await backend.status(session)).toMatchObject({
      state: "unlocked",
      userId: "user-1",
      lastSync: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect((await backend.status(randomBytes(64).toString("base64"))).state).toBe("locked");
    expect((await backend.status("garbage")).state).toBe("locked");
    // The session key itself is never written to disk.
    expect(await readFile(join(home, "vault", "state.json"), "utf8")).not.toContain(session);
  });

  test("decrypts organization and personal items, and per-item keys", async () => {
    await seed(({ userKey, orgKey }) => {
      const itemKey = randomBytes(64);
      return [
        cipher(orgKey, {
          id: "a",
          plainName: "myapp/dev",
          notes: encrypt("envkit:myapp/dev", orgKey),
          fields: [
            { name: encrypt("API_KEY", orgKey), value: encrypt("sk-1", orgKey), type: 1 },
            { name: encrypt("EMPTY", orgKey), value: null, type: 0, linkedId: null },
          ],
        }),
        cipher(userKey, {
          id: "b",
          plainName: "personal",
          organizationId: null,
          collectionIds: [],
        }),
        cipher(itemKey, {
          id: "c",
          plainName: "with item key",
          key: encrypt(itemKey, orgKey),
          fields: [{ name: encrypt("X", itemKey), value: encrypt("1", itemKey), type: 0 }],
        }),
      ];
    });
    const session = await backend.unlock(PASSWORD);
    expect(await backend.getItem(session, "a")).toEqual({
      id: "a",
      organizationId: ORG,
      collectionIds: ["col-1"],
      name: "myapp/dev",
      notes: "envkit:myapp/dev",
      fields: [
        { name: "API_KEY", value: "sk-1", type: FieldType.Hidden },
        { name: "EMPTY", value: null, type: FieldType.Text },
      ],
      revisionDate: "2026-01-02T03:04:05.123Z",
    });
    expect((await backend.getItem(session, "b")).name).toBe("personal");
    expect((await backend.getItem(session, "c")).fields).toEqual([
      { name: "X", value: "1", type: 0 },
    ]);
  });

  test("lists with filters and search, skipping trashed and undecryptable items", async () => {
    await seed(({ orgKey }) => [
      cipher(orgKey, { id: "a", plainName: "myapp/dev" }),
      cipher(orgKey, { id: "b", plainName: "other", notes: encrypt("about MYAPP/prod", orgKey) }),
      cipher(orgKey, { id: "c", plainName: "myapp/old", deletedDate: "2026-01-01T00:00:00Z" }),
      cipher(randomBytes(64), { id: "d", plainName: "myapp/broken" }),
      cipher(orgKey, { id: "e", plainName: "myapp/elsewhere", collectionIds: ["col-2"] }),
    ]);
    const session = await backend.unlock(PASSWORD);
    const ids = async (filter?: Parameters<NativeBackend["listItems"]>[1]) =>
      (await backend.listItems(session, filter)).map((item) => item.id);
    expect(await ids()).toEqual(["a", "b", "e"]);
    expect(await ids({ search: "myapp/" })).toEqual(["a", "b", "e"]);
    expect(await ids({ search: "myapp/", collectionId: "col-1" })).toEqual(["a", "b"]);
    expect(await ids({ organizationId: "org-2" })).toEqual([]);
    await expect(backend.getItem(session, "c")).rejects.toMatchObject({
      message: "Item is in the vault's trash",
      vaultMessage: "Not found.",
    });
    await expect(backend.getItem(session, "zzz")).rejects.toMatchObject({
      message: "Item not found in the vault",
    });
  });

  test("organizations and collections: confirmed ones only, names decrypted", async () => {
    await seed(() => []);
    const session = await backend.unlock(PASSWORD);
    expect(await backend.listOrganizations(session)).toEqual([
      { id: ORG, name: "Acme", role: "user" },
    ]);
    expect(await backend.listCollections(session, ORG)).toEqual([
      { id: "col-1", organizationId: ORG, name: "myapp" },
    ]);
    expect(await backend.listCollections(session, "org-2")).toEqual([]);
  });

  test("locked, logged out and conflicting writes fail before any network call", async () => {
    await seed(({ orgKey }) => [cipher(orgKey, { id: "a", plainName: "myapp/dev" })]);
    const locked = backend.listItems("");
    await expect(locked).rejects.toBeInstanceOf(VaultError);
    await expect(locked).rejects.toMatchObject({ vaultMessage: "Vault is locked." });

    const session = await backend.unlock(PASSWORD);
    const item = await backend.getItem(session, "a");
    await expect(
      backend.updateItem(session, { ...item, revisionDate: "2025-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ message: "This environment changed since envkit read it" });

    await backend.lock();
    expect((await backend.status(session)).state).toBe("locked");

    await expect(backend.setServer("https://other.test")).rejects.toMatchObject({
      message: "Cannot change server while logged in",
    });
    await expect(
      backend.login({ email: EMAIL, password: PASSWORD, interactive: false }),
    ).rejects.toMatchObject({ message: `Already logged in as ${EMAIL}` });

    await backend.logout();
    expect(await backend.status()).toMatchObject({ state: "unauthenticated", serverUrl: SERVER });
    await expect(backend.listItems(session)).rejects.toMatchObject({ message: "Not logged in" });
    await expect(backend.unlock(PASSWORD)).rejects.toMatchObject({ message: "Not logged in" });
  });

  test("a read-only item can't be updated", async () => {
    await seed(({ orgKey }) => [cipher(orgKey, { id: "a", plainName: "myapp/dev", edit: false })]);
    const session = await backend.unlock(PASSWORD);
    const item = await backend.getItem(session, "a");
    await expect(backend.updateItem(session, item)).rejects.toMatchObject({
      message: "You can only read this environment",
    });
  });

  test("an unreachable server is reported with the URL", async () => {
    const offline = NativeBackend.fromEnv({}, home);
    await offline.setServer("https://127.0.0.1:9");
    await expect(
      offline.login({ email: EMAIL, password: PASSWORD, interactive: false }),
    ).rejects.toMatchObject({ message: "Can't reach the vault at https://127.0.0.1:9" });
  });
});
