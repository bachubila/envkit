import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, environmentItemNotes, FieldType, type OrganizationRole } from "@envkit/core";
import { FakeVault } from "@envkit/testkit";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

/** A logged-in Alice (unlocked via ENVKIT_PASSWORD) in an org with the given role. */
function project(
  options: {
    role?: OrganizationRole;
    organizations?: { id: string; name: string; role: OrganizationRole }[];
    interactive?: boolean;
    answers?: string[];
    vault?: FakeVault;
    cwd?: string;
  } = {},
) {
  const h = harness({
    env: { ENVKIT_PASSWORD: ALICE.password },
    interactive: options.interactive,
    answers: options.answers,
    vault: options.vault,
    cwd: options.cwd,
  });
  if (!options.vault) {
    h.vault.seedLogin(SERVER, ALICE.email);
    h.vault.organizations = options.organizations ?? [
      { id: "org-1", name: "Acme", role: options.role ?? "owner" },
    ];
  }
  const readConfig = () => JSON.parse(readFileSync(join(h.cwd, CONFIG_FILE), "utf8"));
  return { ...h, readConfig };
}

describe("envkit init", () => {
  test("creates the collection and environment items, and writes the config", async () => {
    const { envkit, vault, readConfig, cwd } = project();
    const result = await envkit("init", "--project", "myapp", "--env", "dev,prod");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Created collection "myapp" in Acme.');
    expect(result.stdout).toContain('Created environment "dev" (myapp/dev).');
    expect(result.stdout).toContain("It contains IDs only, no secrets.");

    const config = readConfig();
    expect(config).toEqual({
      version: 1,
      server: SERVER,
      organizationId: "org-1",
      project: "myapp",
      defaultEnvironment: "dev",
      environments: {
        dev: { collectionId: "collection-1", itemId: "item-1" },
        prod: { collectionId: "collection-1", itemId: "item-2" },
      },
    });
    const dev = vault.items.get("item-1")!;
    expect(dev).toMatchObject({
      name: "myapp/dev",
      organizationId: "org-1",
      collectionIds: ["collection-1"],
      notes: environmentItemNotes("myapp", "dev"),
      fields: [],
    });
    expect(cwd).toBeTruthy();
  });

  test("defaults: project from the directory name, one dev environment", async () => {
    const { envkit, readConfig, cwd } = project();
    expect((await envkit("init")).code).toBe(0);
    const config = readConfig();
    expect(config.project).toBe(cwd.split("/").at(-1));
    expect(Object.keys(config.environments)).toEqual(["dev"]);
  });

  test("reuses an existing collection and environment item", async () => {
    const { envkit, vault, readConfig } = project();
    vault.collections.push({ id: "col-x", organizationId: "org-1", name: "myapp" });
    vault.items.set("existing", {
      id: "existing",
      organizationId: "org-1",
      collectionIds: ["col-x"],
      name: "myapp/dev (renamed in the web vault)",
      notes: environmentItemNotes("myapp", "dev"),
      fields: [{ name: "API_KEY", value: "x", type: FieldType.Hidden }],
      revisionDate: "2026-11-01T00:00:00.000Z",
    });
    const result = await envkit("init", "--project", "myapp");
    expect(result.stdout).toContain('Using collection "myapp" in Acme.');
    expect(result.stdout).toContain('Found environment "dev"');
    expect(readConfig().environments.dev).toEqual({ collectionId: "col-x", itemId: "existing" });
    expect(vault.calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("syncs before looking at collections", async () => {
    const { envkit, vault } = project();
    await envkit("init", "--project", "myapp");
    const syncAt = vault.calls.indexOf("sync");
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(syncAt).toBeLessThan(vault.calls.indexOf("createCollection myapp"));
  });

  test("a regular member never tries to create a collection (bw would log them out)", async () => {
    const { envkit, vault } = project({ role: "user" });
    const result = await envkit("init", "--project", "myapp");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Collection "myapp" doesn\'t exist in Acme');
    expect(result.stderr).toContain("Only organization owners and admins can create collections");
    expect(vault.calls.some((call) => call.startsWith("createCollection"))).toBe(false);
    expect(vault.account).toBeDefined();
  });

  test("a regular member can init into a collection an admin created", async () => {
    const { envkit, vault } = project({ role: "user" });
    vault.collections.push({ id: "col-x", organizationId: "org-1", name: "myapp" });
    expect((await envkit("init", "--project", "myapp")).code).toBe(0);
  });

  test("--collection picks a different collection", async () => {
    const { envkit, readConfig } = project();
    await envkit("init", "--project", "myapp", "--collection", "Team secrets");
    expect(readConfig().environments.dev.collectionId).toBe("collection-1");
  });

  test("several organizations: --org by name or id, or a prompt", async () => {
    const organizations = [
      { id: "org-1", name: "Acme", role: "owner" as const },
      { id: "org-2", name: "Side project", role: "owner" as const },
    ];
    const noFlag = project({ organizations });
    const failed = await noFlag.envkit("init", "--project", "myapp");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Pick one with --org: Acme, Side project.");

    const byName = project({ organizations });
    await byName.envkit("init", "--project", "myapp", "--org", "side PROJECT");
    expect(byName.readConfig().organizationId).toBe("org-2");

    const byId = project({ organizations });
    await byId.envkit("init", "--project", "myapp", "--org", "org-2");
    expect(byId.readConfig().organizationId).toBe("org-2");

    const unknown = project({ organizations });
    expect((await unknown.envkit("init", "--org", "Nope")).stderr).toContain(
      'No organization "Nope"',
    );

    const prompted = project({
      organizations,
      interactive: true,
      answers: ["myapp", "dev", "Side project"],
    });
    expect((await prompted.envkit("init")).code).toBe(0);
    expect(prompted.prompts.asked).toEqual([
      "Project name",
      "Environments (comma-separated, first is the default)",
      "Organization",
    ]);
    expect(prompted.readConfig().organizationId).toBe("org-2");
  });

  test("no organizations", async () => {
    const { envkit } = project({ organizations: [] });
    const result = await envkit("init");
    expect(result.stderr).toContain("You are not a member of any organization");
  });

  test("refuses to overwrite an existing config without --force", async () => {
    const { envkit, readConfig } = project();
    await envkit("init", "--project", "myapp");
    const again = await envkit("init", "--project", "other");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('.envkit.json already exists for project "myapp"');
    expect((await envkit("init", "--project", "other", "--force")).code).toBe(0);
    expect(readConfig().project).toBe("other");
  });

  test("invalid names are rejected before touching the vault", async () => {
    const { envkit, vault } = project();
    vault.calls.length = 0;
    expect((await envkit("init", "--project", "my app")).stderr).toContain("Invalid project name");
    expect((await envkit("init", "--env", "dev,pr od")).stderr).toContain(
      "Invalid environment name",
    );
    expect(vault.calls).toEqual([]);
  });
});

describe("envkit link", () => {
  test("a teammate links an existing project by name", async () => {
    const alice = project();
    await alice.envkit("init", "--project", "myapp", "--env", "prod,dev");

    const teammate = project({ vault: alice.vault });
    const result = await teammate.envkit("link", "myapp");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Linked "myapp" from Acme: dev (default), prod.');
    // Same items as the original config (default picks dev when present).
    expect(teammate.readConfig()).toEqual({ ...alice.readConfig(), defaultEnvironment: "dev" });
  });

  test("--env picks the default", async () => {
    const alice = project();
    await alice.envkit("init", "--project", "myapp", "--env", "dev,prod");
    const teammate = project({ vault: alice.vault });
    await teammate.envkit("link", "myapp", "--env", "prod");
    expect(teammate.readConfig().defaultEnvironment).toBe("prod");
    expect((await teammate.envkit("link", "myapp", "--env", "qa", "--force")).stderr).toContain(
      "has no environment",
    );
  });

  test("unknown project", async () => {
    const { envkit } = project();
    const result = await envkit("link", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No envkit project "nope" in your vault');
  });

  test("does not confuse projects with similar names", async () => {
    const { envkit, vault } = project();
    await envkit("init", "--project", "myapp-api");
    const other = project({ vault });
    expect((await other.envkit("link", "myapp")).stderr).toContain('No envkit project "myapp"');
  });

  test("project name requires a positional argument", async () => {
    const { envkit } = project();
    const result = await envkit("link");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/missing required positional argument: project/i);
  });
});

describe("envkit env", () => {
  async function initialised(options: Parameters<typeof project>[0] = {}) {
    const p = project(options);
    const result = await p.envkit("init", "--project", "myapp", "--env", "dev,prod");
    expect(result.code, result.stderr).toBe(0);
    return p;
  }

  test("list shows each environment with its variable count", async () => {
    const { envkit, vault } = await initialised();
    vault.items.get("item-1")!.fields = [
      { name: "A", value: "1", type: FieldType.Hidden },
      { name: "B", value: "2", type: FieldType.Hidden },
    ];
    const result = await envkit("env", "list");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("dev   2 variables (default)\nprod  0 variables");
  });

  test("list works from a subdirectory", async () => {
    const { envkit, vault, cwd } = await initialised();
    const sub = join(cwd, "packages", "api");
    mkdirSync(sub, { recursive: true });
    const nested = project({ vault, cwd: sub });
    expect((await nested.envkit("env", "list")).code).toBe(0);
    expect(envkit).toBeDefined();
  });

  test("list flags environments you can't open", async () => {
    const { envkit, vault } = await initialised();
    vault.items.delete("item-2");
    const result = await envkit("env", "list");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("prod  not accessible (Item not found in the vault)");
    expect(result.stderr).toContain("1 environment is not accessible");
  });

  test("list warns when logged in to a different server", async () => {
    const { envkit, cwd } = await initialised();
    const path = join(cwd, CONFIG_FILE);
    const config = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...config, server: "https://elsewhere.test" }));
    const result = await envkit("env", "list");
    expect(result.stderr).toContain(
      `warning: this project uses https://elsewhere.test, but you are logged in to ${SERVER}.`,
    );
  });

  test("commands outside a project explain how to start", async () => {
    const { envkit } = project();
    const result = await envkit("env", "list");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No .envkit.json found");
    expect(result.stderr).toContain("envkit init");
  });

  test("add creates an item in the default environment's collection", async () => {
    const { envkit, readConfig, vault } = await initialised();
    const result = await envkit("env", "add", "staging");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Added environment "staging" (myapp/staging).');
    const staging = readConfig().environments.staging;
    expect(staging.collectionId).toBe("collection-1");
    expect(vault.items.get(staging.itemId)?.name).toBe("myapp/staging");
  });

  test("add --collection puts prod-like environments in their own collection", async () => {
    const { envkit, readConfig } = await initialised();
    const result = await envkit("env", "add", "live", "--collection", "myapp-live", "--default");
    expect(result.stdout).toContain('Created collection "myapp-live".');
    const config = readConfig();
    expect(config.environments.live.collectionId).toBe("collection-2");
    expect(config.defaultEnvironment).toBe("live");
  });

  test("add refuses duplicates and bad names", async () => {
    const { envkit } = await initialised();
    expect((await envkit("env", "add", "dev")).stderr).toContain(
      'Environment "dev" already exists',
    );
    expect((await envkit("env", "add", "no/slash")).stderr).toContain("Invalid environment name");
  });

  test("remove drops it from the config and keeps the vault item", async () => {
    const { envkit, readConfig, vault } = await initialised();
    const result = await envkit("env", "remove", "prod");
    expect(result).toMatchObject({ code: 0 });
    expect(Object.keys(readConfig().environments)).toEqual(["dev"]);
    expect(vault.items.has("item-2")).toBe(true);
  });

  test("remove --delete trashes the item; removing the default picks another", async () => {
    const { envkit, readConfig, vault } = await initialised();
    const result = await envkit("env", "remove", "dev", "--delete");
    expect(result.stdout).toContain('Moved the "dev" item to the vault\'s trash.');
    expect(result.stdout).toContain('"prod" is now the default environment.');
    expect(vault.items.has("item-1")).toBe(false);
    expect(readConfig().defaultEnvironment).toBe("prod");
  });

  test("remove refuses the last environment and unknown names", async () => {
    const { envkit } = await initialised();
    await envkit("env", "remove", "prod");
    expect((await envkit("env", "remove", "dev")).stderr).toContain(
      "is the project's only environment",
    );
    expect((await envkit("env", "remove", "qa")).stderr).toContain('Unknown environment "qa"');
  });

  test("env --help lists the subcommands", async () => {
    const { envkit } = project();
    const result = await envkit("env", "--help");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("remove");
  });
});
