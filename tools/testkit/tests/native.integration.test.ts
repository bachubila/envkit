import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BwCliBackend,
  CONFLICT_MESSAGE,
  FieldType,
  NativeBackend,
  type NewVaultItem,
  type VaultBackend,
  type VaultItem,
} from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { TestOrganization } from "../src/index.ts";
import { BW_PATH, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;
let bw: BwCliBackend;
let native: NativeBackend;
let nativeDir: string;
let bwDataDir: string;
let bwSession: string;
let nativeSession: string;
let organization: TestOrganization;
let collectionId: string;

beforeAll(async () => {
  server = await startTestServer();
  organization = await server.api.createOrganization(server.account, "Parity");
  bwDataDir = join(await server.tempHome(), "bw");
  bw = new BwCliBackend({
    bwPath: BW_PATH,
    appDataDir: bwDataDir,
    env: server.env,
  });
  nativeDir = await server.tempHome();
  native = NativeBackend.fromEnv(server.env, nativeDir);
  for (const backend of [bw, native] as VaultBackend[]) {
    await backend.setServer(server.vaultwarden.url);
  }
  bwSession = await bw.login({ ...server.account, interactive: false });
  nativeSession = await native.login({ ...server.account, interactive: false });
});

afterAll(() => server?.stop());

const byId = (items: VaultItem[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

async function syncBoth() {
  await bw.sync(bwSession);
  await native.sync(nativeSession);
}

/** Every item, collection and organization reads the same through both backends. */
async function expectSameVault() {
  await syncBoth();
  const fromBw = byId(await bw.listItems(bwSession));
  expect(byId(await native.listItems(nativeSession))).toEqual(fromBw);
  for (const item of fromBw) {
    expect(await native.getItem(nativeSession, item.id)).toEqual(
      await bw.getItem(bwSession, item.id),
    );
  }
  expect(await native.listCollections(nativeSession)).toEqual(
    expect.arrayContaining(await bw.listCollections(bwSession)),
  );
  expect(await native.listOrganizations(nativeSession)).toEqual(
    await bw.listOrganizations(bwSession),
  );
  return fromBw;
}

// One vault, read and written through both backends; tests run in order.
describe("the native backend matches bw on the same vault", () => {
  test("status after login", async () => {
    expect(await native.status(nativeSession)).toMatchObject({
      state: "unlocked",
      serverUrl: server.vaultwarden.url,
      email: server.account.email,
    });
    const fromBw = await bw.status(bwSession);
    expect((await native.status(nativeSession)).userId).toBe(fromBw.userId);
  });

  test("reads what bw wrote, item by item", async () => {
    collectionId = (await bw.createCollection(bwSession, organization.id, "parity")).id;
    const items: NewVaultItem[] = [
      {
        organizationId: organization.id,
        collectionIds: [collectionId],
        name: "parity/dev",
        notes: "envkit:parity/dev",
        fields: [
          { name: "API_KEY", value: "sk-123", type: FieldType.Hidden },
          { name: "PORT", value: "3000", type: FieldType.Text },
          { name: "MULTI", value: "line 1\nline 2\n", type: FieldType.Hidden },
          { name: "UNICODE", value: "héllo 👋 ünïcode", type: FieldType.Text },
          { name: "EMPTY", value: null, type: FieldType.Text },
          { name: "FLAG", value: "true", type: FieldType.Boolean },
        ],
      },
      {
        organizationId: null,
        collectionIds: [],
        name: "personal note",
        notes: null,
        fields: [],
      },
    ];
    for (const item of items) await bw.createItem(bwSession, item);
    // A login item, which envkit never creates, to check updates keep data envkit doesn't manage.
    await bw.createItem(bwSession, {
      ...items[1]!,
      name: "a login",
      type: 1,
      login: { username: "me", password: "hunter2", uris: [] },
      secureNote: null,
    } as NewVaultItem);
    expect(await expectSameVault()).toHaveLength(3);
  });

  test("bw reads what native wrote, including updates to items it didn't create", async () => {
    const created = await native.createItem(nativeSession, {
      organizationId: organization.id,
      collectionIds: [collectionId],
      name: "parity/prod",
      notes: "envkit:parity/prod",
      fields: [{ name: "SECRET", value: "s3cr3t", type: FieldType.Hidden }],
    });
    const login = (await native.listItems(nativeSession, { search: "a login" }))[0]!;
    await native.updateItem(nativeSession, {
      ...login,
      fields: [{ name: "ADDED", value: "by native", type: FieldType.Text }],
    });
    await native.updateItem(nativeSession, { ...created, notes: "edited" });
    const items = await expectSameVault();
    expect(items).toHaveLength(4);

    const raw = (await bw.listItems(bwSession, { search: "a login" }))[0]!;
    expect(raw.fields).toEqual([{ name: "ADDED", value: "by native", type: FieldType.Text }]);
    const loginData = await bwRaw(raw.id);
    expect(loginData.login).toMatchObject({ username: "me", password: "hunter2" });
  });

  test("filters and search match", async () => {
    await syncBoth();
    for (const filter of [
      { organizationId: organization.id },
      { collectionId },
      { search: "parity/" },
      { organizationId: organization.id, search: "PROD" },
    ]) {
      expect(byId(await native.listItems(nativeSession, filter))).toEqual(
        byId(await bw.listItems(bwSession, filter)),
      );
    }
  });

  test("a write based on a stale copy is rejected", async () => {
    const [item] = await native.listItems(nativeSession, { search: "parity/dev" });
    await bw.updateItem(bwSession, { ...(await bw.getItem(bwSession, item!.id)), notes: "bw" });
    await expect(
      native.updateItem(nativeSession, { ...item!, notes: "native" }),
    ).rejects.toMatchObject({
      message: CONFLICT_MESSAGE,
    });
  });

  test("deleting moves the item to the trash for both", async () => {
    const [item] = await native.listItems(nativeSession, { search: "parity/prod" });
    await native.deleteItem(nativeSession, item!.id);
    await expect(native.getItem(nativeSession, item!.id)).rejects.toMatchObject({
      message: "Item is in the vault's trash",
    });
    await bw.sync(bwSession);
    await expect(bw.getItem(bwSession, item!.id)).rejects.toMatchObject({
      message: "Item is in the vault's trash",
    });
    await expectSameVault();
  });
});

describe("the native backend's own session and token handling", () => {
  test("errors read the same as bw's", async () => {
    await expect(native.unlock("wrong")).rejects.toMatchObject({
      message: "Incorrect master password",
    });
    await expect(native.listItems("bm90IGEgc2Vzc2lvbg==")).rejects.toMatchObject({
      message: "Vault is locked",
      vaultMessage: "Vault is locked.",
    });
    await expect(native.setServer("https://other.example.test")).rejects.toMatchObject({
      message: "Cannot change server while logged in",
    });
  });

  test("unlocking again invalidates the previous session; lock invalidates all", async () => {
    const second = await native.unlock(server.account.password);
    expect((await native.status(nativeSession)).state).toBe("locked");
    expect((await native.status(second)).state).toBe("unlocked");
    await native.lock();
    expect((await native.status(second)).state).toBe("locked");
    nativeSession = await native.unlock(server.account.password);
  });

  test("an expired access token is refreshed", async () => {
    await editState((state) => (state.account.accessTokenExpiresAt = 0));
    const before = (await readState()).account.accessToken;
    await native.sync(nativeSession);
    expect((await readState()).account.accessToken).not.toBe(before);
  });

  test("a token the server rejects is refreshed and the call retried", async () => {
    await editState((state) => (state.account.accessToken = "rejected"));
    await native.sync(nativeSession);
    expect((await readState()).account.accessToken).not.toBe("rejected");
  });

  test("a revoked login is forgotten", async () => {
    await editState((state) => {
      state.account.accessToken = "rejected";
      state.account.refreshToken = "revoked";
    });
    await expect(native.sync(nativeSession)).rejects.toMatchObject({ message: "Not logged in" });
    expect((await native.status()).state).toBe("unauthenticated");
  });

  test("API-key login, then unlock; the key also renews the access token", async () => {
    const key = await server.api.apiKey(server.account);
    await native.loginWithApiKey(key);
    expect((await native.status()).state).toBe("locked");
    expect((await native.status()).email).toBe(server.account.email);
    const session = await native.unlock(server.account.password);
    expect(await native.listItems(session, { search: "parity/dev" })).toHaveLength(1);
    await editState((state) => (state.account.accessToken = "rejected"));
    await native.sync(session);
    expect((await readState()).account.apiKey).toEqual(key);
    expect((await readState()).account.refreshToken).toBeUndefined();
  });

  test("files are private to the user", async () => {
    const { stat } = await import("node:fs/promises");
    for (const name of ["state.json", "vault.json"]) {
      expect((await stat(join(nativeDir, "vault", name))).mode & 0o777).toBe(0o600);
    }
  });

  test("logout forgets the account and the vault copy", async () => {
    await native.logout();
    expect(await native.status()).toMatchObject({
      state: "unauthenticated",
      serverUrl: server.vaultwarden.url,
    });
    await expect(readFile(join(nativeDir, "vault", "vault.json"))).rejects.toThrow();
  });
});

/** The full item as bw stores it, including what VaultItem leaves out. */
async function bwRaw(id: string): Promise<Record<string, unknown>> {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(
    execFileSync(BW_PATH, ["get", "item", id], {
      env: {
        ...server.env,
        BW_SESSION: bwSession,
        BITWARDENCLI_APPDATA_DIR: bwDataDir,
      },
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

/** The parts of the native backend's state.json these tests poke at. */
interface AnyState {
  account: {
    accessToken: string;
    accessTokenExpiresAt: number;
    refreshToken?: string;
    apiKey?: { clientId: string; clientSecret: string };
  };
}

async function readState(): Promise<AnyState> {
  return JSON.parse(await readFile(join(nativeDir, "vault", "state.json"), "utf8")) as AnyState;
}

async function editState(change: (state: AnyState) => void): Promise<void> {
  const state = await readState();
  change(state);
  await writeFile(join(nativeDir, "vault", "state.json"), JSON.stringify(state));
}
