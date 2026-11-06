import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, FieldType } from "@envkit/core";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

/** A project with dev and prod; prod holds a secret. */
async function project() {
  const env: Record<string, string> = { ENVKIT_PASSWORD: ALICE.password };
  const h = harness({ env });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  const init = await h.envkit("init", "--project", "myapp", "--env", "dev,prod");
  expect(init.code, init.stderr).toBe(0);
  h.vault.items.get("item-1")!.fields = [{ name: "A", value: "dev", type: FieldType.Hidden }];
  h.vault.items.get("item-2")!.fields = [{ name: "A", value: "prod", type: FieldType.Hidden }];
  return { ...h, env };
}

/** Rewrites one environment's item ID in .envkit.json, as a malicious commit could. */
function pointAt(cwd: string, environment: string, itemId: string) {
  const path = join(cwd, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.environments[environment].itemId = itemId;
  writeFileSync(path, JSON.stringify(config));
}

describe("a tampered .envkit.json", () => {
  test("can't swap one environment's item for another's", async () => {
    const { envkit, cwd } = await project();
    pointAt(cwd, "dev", "item-2");
    const result = await envkit("get", "A");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `error: .envkit.json points "dev" at a vault item that isn't myapp/dev`,
    );
    expect(result.stderr).toContain("envkit link myapp --force");
  });

  test("can't point reads or writes at someone else's item", async () => {
    const { envkit, cwd, vault } = await project();
    vault.items.set("trap", {
      id: "trap",
      organizationId: "org-1",
      collectionIds: ["attacker-collection"],
      name: "myapp/dev",
      notes: "envkit:v1\nproject=myapp\nenvironment=dev",
      fields: [],
      revisionDate: "2026-01-01T00:00:00.000Z",
    });
    pointAt(cwd, "dev", "trap");
    expect((await envkit("set", "STOLEN=secret")).code).toBe(1);
    expect(vault.items.get("trap")!.fields).toEqual([]);
    expect(vault.calls.some((call) => call.startsWith("updateItem"))).toBe(false);
  });

  test("env remove --delete won't trash an item that isn't the environment's", async () => {
    const { envkit, cwd, vault } = await project();
    pointAt(cwd, "dev", "item-2");
    const result = await envkit("env", "remove", "dev", "--delete");
    expect(result.code).toBe(1);
    expect(vault.items.has("item-2")).toBe(true);
    expect(vault.calls.some((call) => call.startsWith("deleteItem"))).toBe(false);
  });

  test("env list reports it instead of counting the other item's variables", async () => {
    const { envkit, cwd } = await project();
    pointAt(cwd, "dev", "item-2");
    const result = await envkit("env", "list");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("dev   not accessible (.envkit.json points");
  });
});

describe("envkit run keeps login secrets from the child", () => {
  test("BW_CLIENTID, BW_CLIENTSECRET, BW_SESSION and ENVKIT_PASSWORD", async () => {
    const h = await project();
    const secrets = { BW_CLIENTID: "user.x", BW_CLIENTSECRET: "s", BW_SESSION: "s" };
    Object.assign(h.env, secrets);
    const out = join(h.cwd, "env.json");
    const script = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
    const result = await h.envkit("run", "--", process.execPath, "-e", script);
    expect(result.code, result.stderr).toBe(0);
    const env = JSON.parse(readFileSync(out, "utf8"));
    for (const name of [...Object.keys(secrets), "ENVKIT_PASSWORD"]) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(env.A).toBe("dev");
  });
});

describe("envkit pull --out", () => {
  test("replaces a symlink instead of writing through it", async () => {
    const { envkit, cwd } = await project();
    const target = join(cwd, "elsewhere.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(cwd, ".env"));
    expect((await envkit("pull", "--out", ".env")).code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(lstatSync(join(cwd, ".env")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("A=dev\n");
  });

  test("an existing world-readable file never holds the secrets with its old mode", async () => {
    const { envkit, cwd } = await project();
    const path = join(cwd, ".env");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);
    expect((await envkit("pull", "--out", ".env")).code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("output from vault data", () => {
  test("a field name can't send escape sequences to the terminal", async () => {
    const { envkit, vault } = await project();
    vault.items.get("item-1")!.fields.push({
      name: "\u001b]0;pwned\u0007X",
      value: "v",
      type: FieldType.Hidden,
    });
    const result = await envkit("get", "A");
    expect(result.stderr).toContain(String.raw`skipping field "\u001b]0;pwned\u0007X"`);
    expect(result.stderr).not.toContain("\u001b");
  });
});

describe("variables that can make programs run code", () => {
  async function withUnsafe() {
    const h = await project();
    h.vault.items
      .get("item-1")!
      .fields.push(
        { name: "NODE_OPTIONS", value: "--require /tmp/evil.js", type: FieldType.Hidden },
        { name: "LD_PRELOAD", value: "/tmp/evil.so", type: FieldType.Hidden },
      );
    return h;
  }

  function dump(cwd: string) {
    const out = join(cwd, "env.json");
    const script = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
    return { out, command: ["--", process.execPath, "-e", script] };
  }

  test("run leaves them out and says how to allow them", async () => {
    const h = await withUnsafe();
    const { out, command } = dump(h.cwd);
    // The child's own NODE_OPTIONS would break the dump script, so check it's untouched instead.
    const result = await h.envkit("run", ...command);
    expect(result.code, result.stderr).toBe(0);
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env.A).toBe("dev");
    // `vp run` injects its own LD_PRELOAD to trace file access, so check the vault's value instead.
    expect(env.LD_PRELOAD ?? "").not.toContain("evil");
    expect(env.NODE_OPTIONS ?? "").not.toContain("evil");
    expect(result.stderr).toContain("warning: leaving out NODE_OPTIONS");
    expect(result.stderr).toContain("--allow LD_PRELOAD");
  });

  test("--allow and ENVKIT_ALLOW_VARIABLES let named ones through", async () => {
    const h = await withUnsafe();
    h.env.ENVKIT_ALLOW_VARIABLES = "ld_preload";
    const result = await h.envkit("pull", "--format", "json", "--allow", "NODE_OPTIONS");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      A: "dev",
      NODE_OPTIONS: "--require /tmp/evil.js",
      LD_PRELOAD: "/tmp/evil.so",
    });
    expect(result.stderr).toBe("");
  });

  test("pull leaves them out of every format", async () => {
    const h = await withUnsafe();
    for (const format of ["dotenv", "json", "shell"]) {
      const result = await h.envkit("pull", "--format", format);
      expect(result.stdout, format).not.toContain("evil");
    }
  });

  test("get still prints one asked for by name", async () => {
    const h = await withUnsafe();
    expect((await h.envkit("get", "NODE_OPTIONS")).stdout).toBe("--require /tmp/evil.js");
  });

  test("set warns that teammates won't receive it by default", async () => {
    const h = await project();
    const result = await h.envkit("set", "NODE_OPTIONS=--max-old-space-size=4096");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("warning: NODE_OPTIONS can make programs run arbitrary code");
  });
});
