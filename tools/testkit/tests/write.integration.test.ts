import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, type EnvkitConfig } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cliUser, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => server?.stop());

describe("writing variables to Vaultwarden", () => {
  let alice: Awaited<ReturnType<typeof cliUser>>;
  let bob: Awaited<ReturnType<typeof cliUser>>;
  let carol: Awaited<ReturnType<typeof cliUser>>;

  test("set up: Alice's project, Bob can edit, Carol can only read", async () => {
    const acme = await server.api.createOrganization(server.account, "Acme");
    alice = await cliUser(server, server.account);
    await alice.login();
    expect((await alice.envkit("init", "--project", "myapp", "--env", "dev,prod")).code).toBe(0);
    const config: EnvkitConfig = JSON.parse(await readFile(join(alice.cwd, CONFIG_FILE), "utf8"));
    const collectionIds = [config.environments.dev!.collectionId];

    const bobAccount = await server.register("bob");
    const carolAccount = await server.register("carol");
    await server.api.addMember(server.account, acme, bobAccount, { collectionIds });
    await server.api.addMember(server.account, acme, carolAccount, {
      collectionIds,
      readOnly: true,
    });
    bob = await cliUser(server, bobAccount);
    carol = await cliUser(server, carolAccount);
    for (const user of [bob, carol]) {
      await copyFile(join(alice.cwd, CONFIG_FILE), join(user.cwd, CONFIG_FILE));
      await user.login();
    }
  });

  test("Bob's set shows up in Alice's run after a sync", async () => {
    const set = await bob.envkit("set", "API_KEY=from bob", "PORT=3000");
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toBe('Added API_KEY, PORT in "dev".');

    expect((await alice.envkit("sync")).code).toBe(0);
    const result = alice.spawn(
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.API_KEY, process.env.PORT)",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("from bob 3000\n");
  });

  test("writes always sync first, so Alice's set builds on Bob's", async () => {
    // Alice's local copy is fresh enough that a read wouldn't sync; a write must,
    // or her save would be rejected as based on a stale copy.
    await bob.envkit("set", "FROM_BOB=1");
    expect((await alice.envkit("set", "FROM_ALICE=1")).code).toBe(0);
    const alices = JSON.parse((await alice.envkit("pull", "--format", "json", "--offline")).stdout);
    expect(Object.keys(alices).sort()).toEqual(["API_KEY", "FROM_ALICE", "FROM_BOB", "PORT"]);
    // Offline, Bob still has his own local copy without Alice's change.
    const bobs = JSON.parse((await bob.envkit("pull", "--format", "json", "--offline")).stdout);
    expect(bobs.FROM_ALICE).toBeUndefined();
  });

  test("unset", async () => {
    expect((await alice.envkit("unset", "FROM_BOB", "FROM_ALICE")).code).toBe(0);
    expect((await alice.envkit("list")).stdout).toBe("API_KEY  ********\nPORT     ********");
  });

  test("push a .env file to prod, then diff", async () => {
    await writeFile(join(alice.cwd, "prod.env"), "API_KEY=prod key\nSENTRY_DSN=https://sentry\n");
    const push = await alice.envkit("push", "--from", "prod.env", "-e", "prod", "--yes");
    expect(push.code, push.stderr).toBe(0);
    expect(push.stdout).toContain('Added API_KEY, SENTRY_DSN in "prod".');

    const diff = await alice.envkit("diff", "dev", "prod", "--check");
    expect(diff.code).toBe(1);
    expect(diff.stdout).toContain("only in dev:   PORT");
    expect(diff.stdout).toContain("only in prod:  SENTRY_DSN");
    expect(diff.stdout).toContain("different:     API_KEY");
  });

  test("Carol (read-only) can read but not write, and stays logged in", async () => {
    // Carol's local copy predates Bob's set and isn't 5 minutes old yet.
    expect((await carol.envkit("sync")).code).toBe(0);
    expect((await carol.envkit("get", "PORT")).stdout).toBe("3000");
    const result = await carol.envkit("set", "NOPE=1");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "error: You can only read this environment\nAsk an organization admin for edit access to its collection.",
    );
    const status = JSON.parse((await carol.envkit("status", "--json")).stdout);
    expect(status.state).not.toBe("unauthenticated");
    expect(
      JSON.parse((await carol.envkit("pull", "--format", "json")).stdout).NOPE,
    ).toBeUndefined();
  });
});
