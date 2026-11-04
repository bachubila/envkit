import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FieldType, type VaultField } from "@envkit/core";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

const hidden = (name: string, value: string): VaultField => ({
  name,
  value,
  type: FieldType.Hidden,
});

/** A project with dev and prod, and variables in each. */
async function project(options: { env?: Record<string, string> } = {}) {
  const h = harness({ env: { ENVKIT_PASSWORD: ALICE.password, ...options.env } });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  const init = await h.envkit("init", "--project", "myapp", "--env", "dev,prod");
  expect(init.code, init.stderr).toBe(0);
  h.vault.items.get("item-1")!.fields = [
    hidden("API_KEY", "dev-key"),
    hidden("DB_URL", "postgres://dev"),
  ];
  h.vault.items.get("item-2")!.fields = [hidden("API_KEY", "prod-key")];
  h.vault.calls.length = 0;
  return h;
}

/** A node one-liner that dumps selected env vars to a file and exits with `code`. */
function dumpEnv(file: string, code = 0) {
  const script = `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env)); process.exit(${code})`;
  return [process.execPath, "-e", script];
}

describe("envkit run", () => {
  test("runs the command with the default environment's variables", async () => {
    const { envkit, cwd } = await project();
    const out = join(cwd, "env.json");
    const result = await envkit("run", "--", ...dumpEnv(out));
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env).toMatchObject({ API_KEY: "dev-key", DB_URL: "postgres://dev" });
  });

  test("--env / -e picks another environment", async () => {
    const { envkit, cwd } = await project();
    const out = join(cwd, "env.json");
    await envkit("run", "--env", "prod", "--", ...dumpEnv(out));
    expect(JSON.parse(readFileSync(out, "utf8")).API_KEY).toBe("prod-key");
    await envkit("run", "-e", "dev", "--", ...dumpEnv(out));
    expect(JSON.parse(readFileSync(out, "utf8")).API_KEY).toBe("dev-key");
  });

  test("passes the child's exit code through", async () => {
    const { envkit, cwd } = await project();
    expect((await envkit("run", "--", ...dumpEnv(join(cwd, "x"), 42))).code).toBe(42);
  });

  test("vault wins over the shell unless --no-override", async () => {
    const { envkit, cwd } = await project({ env: { API_KEY: "from-shell" } });
    const out = join(cwd, "env.json");
    await envkit("run", "--", ...dumpEnv(out));
    expect(JSON.parse(readFileSync(out, "utf8")).API_KEY).toBe("dev-key");
    await envkit("run", "--no-override", "--", ...dumpEnv(out));
    expect(JSON.parse(readFileSync(out, "utf8")).API_KEY).toBe("from-shell");
  });

  test("the master password never reaches the child", async () => {
    const { envkit, cwd } = await project({ env: { ENVKIT_SESSION: "nope" } });
    const out = join(cwd, "env.json");
    await envkit("run", "--", ...dumpEnv(out));
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env.ENVKIT_PASSWORD).toBeUndefined();
    expect(env.ENVKIT_SESSION).toBeUndefined();
  });

  test("the command's own --help is not envkit's", async () => {
    const { envkit, cwd } = await project();
    const out = join(cwd, "args.json");
    const script = join(cwd, "args.js");
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`,
    );
    const result = await envkit("run", "--", process.execPath, script, "--help", "-x");
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--help", "-x"]);
  });

  test("runs in the project directory", async () => {
    const { envkit, cwd } = await project();
    const out = join(cwd, "cwd.txt");
    const script = `require("fs").writeFileSync(${JSON.stringify(out)}, process.cwd())`;
    await envkit("run", "--", process.execPath, "-e", script);
    expect(readFileSync(out, "utf8")).toBe(cwd);
  });

  test("missing command", async () => {
    const { envkit } = await project();
    const result = await envkit("run");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("envkit run -- npm start");
  });

  test("unknown executable exits 127", async () => {
    const { envkit } = await project();
    const result = await envkit("run", "--", "definitely-not-a-command-xyz");
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("Command not found: definitely-not-a-command-xyz");
  });

  test("unknown environment", async () => {
    const { envkit } = await project();
    const result = await envkit("run", "-e", "qa", "--", "true");
    expect(result.stderr).toContain('Unknown environment "qa"');
    expect(result.stderr).toContain("This project has: dev, prod.");
  });

  test("an environment you can't open gets an access hint", async () => {
    const { envkit, vault } = await project();
    vault.items.delete("item-2");
    const result = await envkit("run", "-e", "prod", "--", "true");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Can't open environment "prod"`);
    expect(result.stderr).toContain("envkit sync");
  });

  test("field problems are warnings, not failures", async () => {
    const { envkit, vault, cwd } = await project();
    vault.items.get("item-1")!.fields.push(hidden("bad name", "x"));
    const result = await envkit("run", "--", ...dumpEnv(join(cwd, "x")));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('warning: skipping field "bad name": not a valid variable name');
  });
});

describe("syncing before reading", () => {
  test("syncs when the local copy is stale, not when it's fresh, never with --offline", async () => {
    const { envkit, vault } = await project();
    await envkit("list");
    expect(vault.calls).toContain("sync"); // FakeVault never reports a last sync

    vault.calls.length = 0;
    await envkit("list", "--offline");
    expect(vault.calls).not.toContain("sync");

    vault.lastSync = new Date();
    vault.calls.length = 0;
    await envkit("list");
    expect(vault.calls).not.toContain("sync");
  });

  test("ENVKIT_SYNC_INTERVAL_MINUTES=0 always syncs", async () => {
    const { envkit, vault } = await project({ env: { ENVKIT_SYNC_INTERVAL_MINUTES: "0" } });
    vault.lastSync = new Date();
    await envkit("list");
    expect(vault.calls).toContain("sync");
  });

  test("envkit sync", async () => {
    const { envkit, vault } = await project();
    expect(await envkit("sync")).toMatchObject({ code: 0, stdout: "Synced." });
    expect(vault.calls).toEqual(["status", "sync"]);
  });
});

describe("envkit pull", () => {
  test("prints dotenv to stdout by default", async () => {
    const { envkit } = await project();
    const result = await envkit("pull");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("API_KEY=dev-key\nDB_URL=postgres://dev");
  });

  test("--format json and shell", async () => {
    const { envkit } = await project();
    expect(JSON.parse((await envkit("pull", "--format", "json")).stdout)).toEqual({
      API_KEY: "dev-key",
      DB_URL: "postgres://dev",
    });
    expect((await envkit("pull", "--format", "shell", "-e", "prod")).stdout).toBe(
      "export API_KEY='prod-key'",
    );
    expect((await envkit("pull", "--format", "yaml")).stderr).toContain(
      "Expected one of: dotenv, json, shell.",
    );
  });

  test("--out writes the file with mode 600", async () => {
    const { envkit, cwd } = await project();
    const result = await envkit("pull", "--out", ".env");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('Wrote 2 variables from "dev" to .env.');
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(
      "API_KEY=dev-key\nDB_URL=postgres://dev\n",
    );
    expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);
  });

  test("--out warns when git would commit the file", async () => {
    const { envkit, cwd } = await project();
    execFileSync("git", ["init", "--quiet"], { cwd });
    const exposed = await envkit("pull", "--out", "secrets.env");
    expect(exposed.stderr).toContain("warning: secrets.env is not ignored by git");

    writeFileSync(join(cwd, ".gitignore"), "secrets.env\n");
    const ignored = await envkit("pull", "--out", "secrets.env");
    expect(ignored.stderr).not.toContain("warning");
  });
});

describe("envkit get / list", () => {
  test("get prints one value", async () => {
    const { envkit } = await project();
    expect(await envkit("get", "DB_URL")).toMatchObject({ code: 0, stdout: "postgres://dev" });
    expect((await envkit("get", "API_KEY", "-e", "prod")).stdout).toBe("prod-key");
  });

  test("get of a missing variable", async () => {
    const { envkit } = await project();
    const result = await envkit("get", "NOPE");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No variable NOPE in "dev"');
  });

  test("list hides values unless --reveal", async () => {
    const { envkit } = await project();
    expect((await envkit("list")).stdout).toBe("API_KEY  ********\nDB_URL   ********");
    expect((await envkit("list", "--reveal")).stdout).toBe(
      "API_KEY  dev-key\nDB_URL   postgres://dev",
    );
  });

  test("list of an empty environment", async () => {
    const { envkit, vault } = await project();
    vault.items.get("item-2")!.fields = [];
    const result = await envkit("list", "-e", "prod");
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: '"prod" has no variables yet.' });
  });
});
