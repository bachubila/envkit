import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, FieldType, type EnvkitConfig } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cliUser, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => server?.stop());

describe("reading variables from Vaultwarden", () => {
  let alice: Awaited<ReturnType<typeof cliUser>>;
  let bob: Awaited<ReturnType<typeof cliUser>>;
  let config: EnvkitConfig;

  /** Replaces the dev environment's variables, as Phase 4's `envkit set` will. */
  async function setVariables(variables: Record<string, string>) {
    const { backend, session } = await alice.backend();
    const item = await backend.getItem(session, config.environments.dev!.itemId);
    await backend.updateItem(session, {
      ...item,
      fields: Object.entries(variables).map(([name, value]) => ({
        name,
        value,
        type: FieldType.Hidden,
      })),
    });
  }

  test("set up: Alice creates the project and stores a variable", async () => {
    const acme = await server.api.createOrganization(server.account, "Acme");
    alice = await cliUser(server, server.account);
    await alice.login();
    expect((await alice.envkit("init", "--project", "myapp")).code).toBe(0);
    config = JSON.parse(await readFile(join(alice.cwd, CONFIG_FILE), "utf8"));
    await setVariables({ API_KEY: "s3cret from the vault", MULTI: "line 1\nline 2" });

    const bobAccount = await server.register("bob");
    await server.api.addMember(server.account, acme, bobAccount, {
      collectionIds: [config.environments.dev!.collectionId],
    });
    bob = await cliUser(server, bobAccount);
    await copyFile(join(alice.cwd, CONFIG_FILE), join(bob.cwd, CONFIG_FILE));
    await bob.login();
  });

  test("envkit run -- node -e 'console.log(process.env.API_KEY)' prints the stored value", () => {
    const result = alice.spawn(
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.API_KEY)",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("s3cret from the vault\n");
    expect(result.status).toBe(0);
  });

  test("pull, get and list", async () => {
    const pulled = await alice.envkit("pull", "--format", "json");
    expect(JSON.parse(pulled.stdout)).toEqual({
      API_KEY: "s3cret from the vault",
      MULTI: "line 1\nline 2",
    });
    expect((await alice.envkit("get", "MULTI")).stdout).toBe("line 1\nline 2");
    expect((await alice.envkit("list")).stdout).toBe("API_KEY  ********\nMULTI    ********");
  });

  test("Bob reads the same values", async () => {
    expect((await bob.envkit("get", "API_KEY")).stdout).toBe("s3cret from the vault");
  });

  test("Bob sees Alice's change after a sync", async () => {
    await setVariables({ API_KEY: "rotated" });
    // Bob's local copy is fresh (synced at login), so envkit doesn't sync yet.
    expect((await bob.envkit("get", "API_KEY")).stdout).toBe("s3cret from the vault");
    expect((await bob.envkit("sync")).code).toBe(0);
    expect((await bob.envkit("get", "API_KEY")).stdout).toBe("rotated");
  });
});
