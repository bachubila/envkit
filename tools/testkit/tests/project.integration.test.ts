import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, type EnvkitConfig } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { TestAccount, TestOrganization } from "../src/index.ts";
import { cliUser, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;
let bob: TestAccount;
let acme: TestOrganization;

beforeAll(async () => {
  server = await startTestServer();
  bob = await server.api.registerAccount({ email: "bob@example.test", password: "bob's password" });
  acme = await server.api.createOrganization(server.account, "Acme");
});

afterAll(() => server?.stop());

const readConfig = async (dir: string) =>
  JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf8")) as EnvkitConfig;

// One team walked through setting up and sharing a project, so tests run in order.
describe("sharing a project between two users", () => {
  let alice: Awaited<ReturnType<typeof cliUser>>;
  let bobsClone: Awaited<ReturnType<typeof cliUser>>;
  let config: EnvkitConfig;

  test("Alice (owner) runs init: collection, items and .envkit.json", async () => {
    alice = await cliUser(server, server.account);
    await alice.login();
    const result = await alice.envkit("init", "--project", "myapp", "--env", "dev,prod");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Created collection "myapp" in Acme.');
    config = await readConfig(alice.cwd);
    expect(config).toMatchObject({
      server: server.vaultwarden.url,
      organizationId: acme.id,
      project: "myapp",
      defaultEnvironment: "dev",
    });
    expect(Object.keys(config.environments)).toEqual(["dev", "prod"]);

    const list = await alice.envkit("env", "list");
    expect(list.stdout).toBe("dev   0 variables (default)\nprod  0 variables");
  });

  test("running init again reuses everything", async () => {
    const result = await alice.envkit("init", "--project", "myapp", "--env", "dev,prod", "--force");
    expect(result.stdout).toContain('Using collection "myapp"');
    expect(result.stdout).toContain('Found environment "dev"');
    expect(await readConfig(alice.cwd)).toEqual(config);
  });

  test("Bob, given access to the collection, resolves the same items from a clone", async () => {
    await server.api.addMember(server.account, acme, bob, {
      collectionIds: [config.environments.dev!.collectionId],
    });
    bobsClone = await cliUser(server, bob);
    await copyFile(join(alice.cwd, CONFIG_FILE), join(bobsClone.cwd, CONFIG_FILE));
    await bobsClone.login();

    const list = await bobsClone.envkit("env", "list");
    expect(list, list.stderr).toMatchObject({ code: 0, stderr: "" });
    expect(list.stdout).toBe("dev   0 variables (default)\nprod  0 variables");
  });

  test("Bob can also link the project by name and gets the same config", async () => {
    const bobsOtherRepo = await cliUser(server, bob);
    await bobsOtherRepo.login();
    const result = await bobsOtherRepo.envkit("link", "myapp");
    expect(result.code, result.stderr).toBe(0);
    expect(await readConfig(bobsOtherRepo.cwd)).toEqual(config);
  });

  test("Bob (regular member) can't create collections and stays logged in", async () => {
    const result = await bobsClone.envkit("init", "--project", "bobs-app", "--force");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Only organization owners and admins can create collections");
    const status = JSON.parse((await bobsClone.envkit("status", "--json")).stdout);
    expect(status.state).not.toBe("unauthenticated");
  });

  test("an environment in a restricted collection is invisible to Bob", async () => {
    const add = await alice.envkit("env", "add", "live", "--collection", "myapp-live");
    expect(add.code, add.stderr).toBe(0);
    await copyFile(join(alice.cwd, CONFIG_FILE), join(bobsClone.cwd, CONFIG_FILE));

    const list = await bobsClone.envkit("env", "list");
    expect(list.code).toBe(1);
    expect(list.stdout).toContain("live  not accessible");
    expect(list.stdout).toContain("dev   0 variables (default)");
  });

  test("removing with --delete moves the item to the trash", async () => {
    const result = await alice.envkit("env", "remove", "live", "--delete");
    expect(result.code, result.stderr).toBe(0);
    expect((await readConfig(alice.cwd)).environments.live).toBeUndefined();
  });
});
