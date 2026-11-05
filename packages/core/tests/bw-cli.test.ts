import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createFakeBw, type FakeBw } from "../../../tools/testkit/src/fake-bw.ts";
import {
  BwCliBackend,
  BwError,
  compareVersions,
  CONFLICT_MESSAGE,
  EnvkitError,
  FieldType,
} from "../src/index.ts";

let bw: FakeBw;
let backend: BwCliBackend;

beforeEach(async () => {
  bw = await createFakeBw();
  backend = new BwCliBackend({
    bwPath: bw.path,
    appDataDir: "/tmp/envkit-test/bw",
    env: { PATH: process.env.PATH, BW_SESSION: "users-own-session" },
  });
});

afterEach(() => bw.cleanup());

const ok = (data: unknown) => ({ stdout: { success: true, data } });
const fail = (message: string) => ({ stdout: { success: false, message }, code: 1 });

describe("BwCliBackend", () => {
  test("status maps bw's template and runs in envkit's private data dir", async () => {
    await bw.respond(
      "status",
      ok({
        object: "template",
        template: {
          serverUrl: "https://vault.test",
          lastSync: "2026-11-03T10:00:00.000Z",
          userEmail: "alice@example.test",
          userId: "u1",
          status: "locked",
        },
      }),
    );
    expect(await backend.status()).toEqual({
      state: "locked",
      serverUrl: "https://vault.test",
      email: "alice@example.test",
      userId: "u1",
      lastSync: new Date("2026-11-03T10:00:00.000Z"),
    });
    const [, call] = await bw.calls();
    expect(call?.args).toEqual(["status", "--response", "--nointeraction"]);
    expect(call?.env.BITWARDENCLI_APPDATA_DIR).toBe("/tmp/envkit-test/bw");
    // The user's own BW_SESSION belongs to their personal bw data dir; never leak it in.
    expect(call?.env.BW_SESSION).toBeUndefined();
  });

  test("passes the session through BW_SESSION, not argv", async () => {
    await bw.respond("status", ok({ template: { status: "unlocked" } }));
    await backend.status("s3ss10n");
    const [, call] = await bw.calls();
    expect(call?.env.BW_SESSION).toBe("s3ss10n");
    expect(call?.args.join(" ")).not.toContain("s3ss10n");
  });

  test("login sends the password through the environment and returns the session", async () => {
    await bw.respond("login", ok({ object: "message", raw: "new-session" }));
    const session = await backend.login({
      email: "alice@example.test",
      password: "hunter2",
      interactive: false,
    });
    expect(session).toBe("new-session");
    const [, call] = await bw.calls();
    expect(call?.args).toEqual([
      "login",
      "alice@example.test",
      "--passwordenv",
      "ENVKIT_BW_PASSWORD",
      "--response",
      "--nointeraction",
    ]);
    expect(call?.env.ENVKIT_BW_PASSWORD).toBe("hunter2");
  });

  test("API key login passes the key through the environment", async () => {
    await bw.respond("login", ok({ object: "message" }));
    await backend.loginWithApiKey({ clientId: "user.abc", clientSecret: "shh" });
    const [, call] = await bw.calls();
    expect(call?.args).toEqual(["login", "--apikey", "--response", "--nointeraction"]);
    expect(call?.env).toMatchObject({ BW_CLIENTID: "user.abc", BW_CLIENTSECRET: "shh" });
  });

  test("unlock returns the session key", async () => {
    await bw.respond("unlock", ok({ raw: "unlocked-session" }));
    expect(await backend.unlock("hunter2")).toBe("unlocked-session");
  });

  test("a missing session key in the response is an error", async () => {
    await bw.respond("unlock", ok({ object: "message" }));
    await expect(backend.unlock("hunter2")).rejects.toThrow("did not return a session key");
  });

  test("lists organizations and collections", async () => {
    await bw.respond(
      "list organizations",
      ok({
        data: [
          { id: "o1", name: "Acme", status: 2, type: 0 },
          { id: "o2", name: "Other", status: 2, type: 2 },
        ],
      }),
    );
    await bw.respond(
      "list collections",
      ok({ data: [{ id: "c1", organizationId: "o1", name: "myapp", externalId: null }] }),
    );
    expect(await backend.listOrganizations("s")).toEqual([
      { id: "o1", name: "Acme", role: "owner" },
      { id: "o2", name: "Other", role: "user" },
    ]);
    expect(await backend.listCollections("s", "o1")).toEqual([
      { id: "c1", organizationId: "o1", name: "myapp" },
    ]);
    const calls = await bw.calls();
    expect(calls.at(-1)?.args.slice(0, 4)).toEqual([
      "list",
      "collections",
      "--organizationid",
      "o1",
    ]);
  });

  const rawItem = {
    object: "item",
    id: "i1",
    organizationId: "o1",
    collectionIds: ["c1"],
    type: 2,
    name: "myapp/dev",
    notes: "envkit:v1",
    secureNote: { type: 0 },
    fields: [{ name: "API_KEY", value: "s3cret", type: 1, linkedId: null }],
    revisionDate: "2026-11-03T10:00:00.000Z",
    favorite: false,
  };

  test("getItem maps the fields envkit uses", async () => {
    await bw.respond("get item i1", ok(rawItem));
    expect(await backend.getItem("s", "i1")).toEqual({
      id: "i1",
      organizationId: "o1",
      collectionIds: ["c1"],
      name: "myapp/dev",
      notes: "envkit:v1",
      fields: [{ name: "API_KEY", value: "s3cret", type: FieldType.Hidden }],
      revisionDate: "2026-11-03T10:00:00.000Z",
    });
  });

  test("createItem sends a secure note on stdin, keeping values out of argv", async () => {
    await bw.respond("create item", ok(rawItem));
    await backend.createItem("s", {
      organizationId: "o1",
      collectionIds: ["c1"],
      name: "myapp/dev",
      notes: "envkit:v1",
      fields: [{ name: "API_KEY", value: "s3cret", type: FieldType.Hidden }],
    });
    const call = (await bw.calls()).at(-1);
    expect(call?.args).toEqual(["create", "item", "--response", "--nointeraction"]);
    expect(call?.args.join(" ")).not.toContain("s3cret");
    expect(JSON.parse(Buffer.from(call?.stdin ?? "", "base64").toString())).toMatchObject({
      type: 2,
      secureNote: { type: 0 },
      organizationId: "o1",
      collectionIds: ["c1"],
      fields: [{ name: "API_KEY", value: "s3cret", type: 1 }],
    });
  });

  test("updateItem keeps fields envkit doesn't own", async () => {
    await bw.respond("get item i1", ok(rawItem));
    await bw.respond("edit item i1", ok({ ...rawItem, fields: [] }));
    await backend.updateItem("s", {
      id: "i1",
      organizationId: "o1",
      collectionIds: ["c1"],
      name: "myapp/dev",
      notes: "envkit:v1",
      fields: [],
      revisionDate: rawItem.revisionDate,
    });
    const edit = (await bw.calls()).at(-1);
    const payload = JSON.parse(Buffer.from(edit?.stdin ?? "", "base64").toString());
    expect(payload).toMatchObject({ favorite: false, secureNote: { type: 0 }, fields: [] });
  });

  test("createCollection sends the payload on stdin", async () => {
    await bw.respond(
      "create org-collection",
      ok({ object: "org-collection", id: "c9", organizationId: "o1", name: "myapp", users: [] }),
    );
    expect(await backend.createCollection("s", "o1", "myapp")).toEqual({
      id: "c9",
      organizationId: "o1",
      name: "myapp",
    });
    const call = (await bw.calls()).at(-1);
    expect(call?.args.slice(0, 4)).toEqual(["create", "org-collection", "--organizationid", "o1"]);
    expect(JSON.parse(Buffer.from(call?.stdin ?? "", "base64").toString())).toEqual({
      organizationId: "o1",
      name: "myapp",
      externalId: null,
      groups: [],
      users: [],
    });
  });

  test("listItems passes filters and drops trashed items", async () => {
    await bw.respond(
      "list items",
      ok({
        data: [
          rawItem,
          { ...rawItem, id: "i2", name: "myapp/old", deletedDate: "2026-11-01T00:00:00.000Z" },
        ],
      }),
    );
    const items = await backend.listItems("s", {
      organizationId: "o1",
      collectionId: "c1",
      search: "myapp/",
    });
    expect(items.map((item) => item.id)).toEqual(["i1"]);
    expect((await bw.calls()).at(-1)?.args.slice(0, 8)).toEqual([
      "list",
      "items",
      "--organizationid",
      "o1",
      "--collectionid",
      "c1",
      "--search",
      "myapp/",
    ]);
  });

  test("getItem treats trashed items as gone", async () => {
    await bw.respond("get item i1", ok({ ...rawItem, deletedDate: "2026-11-01T00:00:00.000Z" }));
    await expect(backend.getItem("s", "i1")).rejects.toMatchObject({
      message: "Item is in the vault's trash",
      hint: "Restore it in the web vault.",
    });
  });

  test("deleteItem", async () => {
    await bw.respond("delete item i1", { stdout: { success: true } });
    await backend.deleteItem("s", "i1");
    expect((await bw.calls()).at(-1)?.args.slice(0, 3)).toEqual(["delete", "item", "i1"]);
  });

  test("updateItem refuses when the item changed since it was read", async () => {
    await bw.respond("get item i1", ok({ ...rawItem, revisionDate: "2026-11-04T09:00:00.000Z" }));
    const error = await backend
      .updateItem("s", {
        ...(await backend.getItem("s", "i1")),
        revisionDate: rawItem.revisionDate,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: CONFLICT_MESSAGE });
    expect((await bw.calls()).some((call) => call.args[0] === "edit")).toBe(false);
  });

  test("the server's stale-copy error maps to the same conflict", async () => {
    await bw.respond(
      "sync",
      fail("The client copy of this cipher is out of date. Resync the client and try again."),
    );
    await expect(backend.sync("s")).rejects.toMatchObject({ message: CONFLICT_MESSAGE });
  });

  test("logout when already logged out succeeds", async () => {
    await bw.respond("logout", fail("You are not logged in."));
    await expect(backend.logout()).resolves.toBeUndefined();
  });

  test.each([
    ["Vault is locked.", "Vault is locked", "Run `envkit unlock`."],
    ["You are not logged in.", "Not logged in", "Run `envkit login`."],
    [
      "You are already logged in as bob@example.test.",
      "Already logged in as bob@example.test",
      "Run `envkit logout` first.",
    ],
    [
      "Username or password is incorrect. Try again",
      "Email or master password is incorrect",
      "Check both and try again.",
    ],
    ["Cryptography error, The decryption operation failed", "Incorrect master password", undefined],
    ["Not found.", "Item not found in the vault", undefined],
    [
      "You do not have permission to edit this item",
      "You can only read this environment",
      "Ask an organization admin for edit access to its collection.",
    ],
    ["Something new", "bw: Something new", undefined],
  ])("maps bw error %j", async (bwMessage, message, hint) => {
    await bw.respond("sync", fail(bwMessage));
    const error = await backend.sync("s").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BwError);
    expect(error).toMatchObject({ message, hint, bwMessage });
  });

  test("unparseable output becomes an EnvkitError with bw's last stderr line", async () => {
    await bw.respond("sync", {
      stdout: "",
      stderr: "ERROR bitwarden_core: noise\nconnect ECONNREFUSED 127.0.0.1:443\n",
      code: 1,
    });
    await expect(backend.sync("s")).rejects.toMatchObject({
      message: "Unexpected output from `bw sync`",
      hint: "connect ECONNREFUSED 127.0.0.1:443",
    });
  });

  test("rejects a bw that is too old", async () => {
    const old = await createFakeBw("2023.12.0");
    const oldBackend = new BwCliBackend({ bwPath: old.path, appDataDir: "/tmp/x" });
    await expect(oldBackend.status()).rejects.toThrow("bw 2023.12.0 is too old");
    await old.cleanup();
  });

  test("checks the version only once", async () => {
    await bw.respond("status", ok({ template: { status: "unauthenticated" } }));
    await backend.status();
    await backend.status();
    const versionChecks = (await bw.calls()).filter((call) => call.args[0] === "--version");
    expect(versionChecks).toHaveLength(1);
  });

  test("remembers the checked version across processes until bw changes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "envkit-version-"));
    const versionCachePath = join(cacheDir, "bw-version.json");
    const fresh = () =>
      new BwCliBackend({ bwPath: bw.path, appDataDir: "/tmp/x", versionCachePath });
    const versionChecks = async () =>
      (await bw.calls()).filter((call) => call.args[0] === "--version").length;
    await bw.respond("status", ok({ template: { status: "unauthenticated" } }));

    await fresh().status();
    await fresh().status();
    expect(await versionChecks()).toBe(1);

    // An upgrade rewrites the executable.
    const later = new Date(Date.now() + 60_000);
    await utimes(bw.path, later, later);
    await fresh().status();
    expect(await versionChecks()).toBe(2);
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("a cached version doesn't hide a downgrade below the minimum", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "envkit-version-"));
    const versionCachePath = join(cacheDir, "bw-version.json");
    const old = await createFakeBw("2023.12.0");
    const oldBackend = () =>
      new BwCliBackend({ bwPath: old.path, appDataDir: "/tmp/x", versionCachePath });
    await expect(oldBackend().status()).rejects.toThrow("bw 2023.12.0 is too old");
    await expect(oldBackend().status()).rejects.toThrow("bw 2023.12.0 is too old");
    await old.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("a missing bw executable explains how to install it", async () => {
    const missing = new BwCliBackend({ bwPath: "/nonexistent/bw", appDataDir: "/tmp/x" });
    const error = await missing.status().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnvkitError);
    expect(error).toMatchObject({ message: "Bitwarden CLI not found (`/nonexistent/bw`)" });
    expect((error as EnvkitError).hint).toContain("npm install -g @bitwarden/cli");
  });
});

describe("compareVersions", () => {
  test.each([
    ["2026.10.0", "2026.1.0", 1],
    ["2026.1.0", "2026.1.0", 0],
    ["2025.12.3", "2026.1.0", -1],
    ["2026.1", "2026.1.0", 0],
  ])("%s vs %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
