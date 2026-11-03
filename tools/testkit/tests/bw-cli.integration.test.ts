import { join } from "node:path";
import { BwCliBackend, FieldType } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BW_PATH, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;
let backend: BwCliBackend;

beforeAll(async () => {
  server = await startTestServer();
  backend = new BwCliBackend({
    bwPath: BW_PATH,
    appDataDir: join(await server.tempHome(), "bw"),
    env: server.env,
  });
});

afterAll(() => server?.stop());

// One account walked through its lifecycle, so the tests share state and run in order.
describe("BwCliBackend against Vaultwarden", () => {
  let session: string;

  test("starts logged out", async () => {
    expect((await backend.status()).state).toBe("unauthenticated");
  });

  test("a wrong password is reported clearly", async () => {
    await backend.setServer(server.vaultwarden.url);
    await expect(
      backend.login({ email: server.account.email, password: "wrong", interactive: false }),
    ).rejects.toMatchObject({ message: "Email or master password is incorrect" });
  });

  test("login returns a working session", async () => {
    session = await backend.login({ ...server.account, interactive: false });
    expect(session).toMatch(/\S{40,}/);
    expect(await backend.status(session)).toMatchObject({
      state: "unlocked",
      serverUrl: server.vaultwarden.url,
      email: server.account.email,
    });
    expect((await backend.status()).state).toBe("locked");
  });

  test("logging in twice is refused", async () => {
    await expect(backend.login({ ...server.account, interactive: false })).rejects.toMatchObject({
      message: `Already logged in as ${server.account.email}`,
    });
  });

  test("changing server while logged in is refused", async () => {
    await expect(backend.setServer("https://elsewhere.test")).rejects.toMatchObject({
      message: "Cannot change server while logged in",
    });
  });

  test("create, read and update an item with hidden fields", async () => {
    const created = await backend.createItem(session, {
      organizationId: null,
      collectionIds: [],
      name: "myapp/dev",
      notes: "envkit:v1",
      fields: [{ name: "API_KEY", value: "s3cret value=with|chars", type: FieldType.Hidden }],
    });
    expect(created.id).toBeTruthy();

    const read = await backend.getItem(session, created.id);
    expect(read.fields).toEqual([
      { name: "API_KEY", value: "s3cret value=with|chars", type: FieldType.Hidden },
    ]);

    const updated = await backend.updateItem(session, {
      ...read,
      fields: [...read.fields, { name: "DB_URL", value: "postgres://db", type: FieldType.Hidden }],
    });
    expect(updated.fields.map((field) => field.name)).toEqual(["API_KEY", "DB_URL"]);
    expect(updated.revisionDate).not.toBe(read.revisionDate);
  });

  test("missing items map to a clear error", async () => {
    await expect(
      backend.getItem(session, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ message: "Item not found in the vault" });
  });

  test("sync and list organizations", async () => {
    await backend.sync(session);
    expect(await backend.listOrganizations(session)).toEqual([]);
  });

  test("lock invalidates the session; unlock issues a new one", async () => {
    await backend.lock();
    expect((await backend.status(session)).state).toBe("locked");
    // `bw sync` only needs the login token and works while locked; reading data does not.
    await expect(backend.listOrganizations(session)).rejects.toMatchObject({
      message: "Vault is locked",
    });

    await expect(backend.unlock("wrong")).rejects.toMatchObject({
      message: "Incorrect master password",
    });
    const fresh = await backend.unlock(server.account.password);
    expect((await backend.status(fresh)).state).toBe("unlocked");
  });

  test("logout, twice", async () => {
    await backend.logout();
    expect((await backend.status()).state).toBe("unauthenticated");
    await expect(backend.logout()).resolves.toBeUndefined();
  });
});
