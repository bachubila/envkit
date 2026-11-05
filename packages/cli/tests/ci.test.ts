import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FieldType } from "@envkit/core";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

/**
 * A linked project with variables in "dev". `env` stays mutable, so a test
 * can change the environment after setting up.
 */
async function project(options: { interactive?: boolean; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = { ENVKIT_PASSWORD: ALICE.password, ...options.env };
  const h = harness({ env, interactive: options.interactive });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  const init = await h.envkit("init", "--project", "myapp", "--env", "dev");
  expect(init.code, init.stderr).toBe(0);
  h.vault.items.get("item-1")!.fields = [
    { name: "API_KEY", value: "sk-dev-123", type: FieldType.Hidden },
    { name: "PORT", value: "3000", type: FieldType.Text },
  ];
  h.vault.lastSync = new Date();
  await h.sessions.recordSync();
  h.vault.calls.length = 0;
  return { ...h, env };
}

/** The same project on a fresh CI runner: `bw` has never logged in. */
async function freshRunner(env: Record<string, string> = {}) {
  const h = await project({ env });
  await h.vault.logout();
  h.vault.serverUrl = undefined;
  await h.sessions.clear();
  h.vault.calls.length = 0;
  return h;
}

describe("logging in without a terminal", () => {
  test("uses BW_CLIENTID/BW_CLIENTSECRET and the project's server", async () => {
    const { envkit, vault } = await freshRunner({
      BW_CLIENTID: ALICE.clientId!,
      BW_CLIENTSECRET: ALICE.clientSecret!,
    });
    const result = await envkit("get", "API_KEY");
    expect(result).toMatchObject({ code: 0, stdout: "sk-dev-123" });
    expect(result.stderr).toBe(`Logged in as ${ALICE.email} on ${SERVER}.`);
    expect(vault.calls).toEqual(
      expect.arrayContaining([`setServer ${SERVER}`, "loginWithApiKey", "unlock"]),
    );
  });

  test("uses ENVKIT_EMAIL/ENVKIT_PASSWORD, which unlocks in the same step", async () => {
    const { envkit, vault } = await freshRunner({ ENVKIT_EMAIL: ALICE.email });
    expect(await envkit("get", "API_KEY")).toMatchObject({ code: 0, stdout: "sk-dev-123" });
    expect(vault.calls).toContain(`login ${ALICE.email}`);
    expect(vault.calls).not.toContain("unlock");
  });

  test("ENVKIT_SERVER wins over the project's server", async () => {
    const { envkit, vault } = await freshRunner({
      ENVKIT_EMAIL: ALICE.email,
      ENVKIT_SERVER: "https://other.example.test/",
    });
    await envkit("get", "API_KEY");
    expect(vault.calls).toContain("setServer https://other.example.test");
  });

  test("explains the env vars when there are no credentials", async () => {
    const { envkit } = await freshRunner();
    const result = await envkit("get", "API_KEY");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "error: Not logged in\nRun `envkit login`, or set BW_CLIENTID and BW_CLIENTSECRET (or ENVKIT_EMAIL) with ENVKIT_PASSWORD to log in automatically.",
    );
  });

  test("never logs in on its own in a terminal", async () => {
    const h = await project({ interactive: true, env: { ENVKIT_EMAIL: ALICE.email } });
    await h.vault.logout();
    await h.sessions.clear();
    const result = await h.envkit("get", "API_KEY");
    expect(result.stderr).toBe("error: Not logged in\nRun `envkit login`.");
    expect(h.vault.calls.some((call) => call.startsWith("login"))).toBe(false);
  });

  test("a wrong API key fails with bw's message", async () => {
    const { envkit } = await freshRunner({ BW_CLIENTID: "user.x", BW_CLIENTSECRET: "nope" });
    const result = await envkit("get", "API_KEY");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: /);
  });
});

describe("--non-interactive", () => {
  test("never prompts, before or after the command name", async () => {
    const h = await project({ interactive: true });
    delete h.env.ENVKIT_PASSWORD;
    await h.sessions.clear();
    for (const args of [
      ["--non-interactive", "get", "API_KEY"],
      ["get", "--non-interactive", "API_KEY"],
    ]) {
      const result = await h.envkit(...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "error: Vault is locked\nRun `envkit unlock` in a terminal, or set ENVKIT_PASSWORD.",
      );
    }
    expect(h.prompts.asked).toEqual([]);
  });

  test("after `--` it belongs to the command envkit runs", async () => {
    const { envkit, cwd } = await project();
    const out = join(cwd, "argv.json");
    const script = join(cwd, "argv.js");
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`,
    );
    const result = await envkit("run", "--", process.execPath, script, "--non-interactive");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--non-interactive"]);
  });
});

describe("GitHub Actions", () => {
  test("masks every value it reads before printing anything", async () => {
    const { envkit } = await project({ env: { GITHUB_ACTIONS: "true" } });
    const result = await envkit("get", "API_KEY");
    expect(result.stdout).toBe("sk-dev-123");
    // PORT=3000 is masked too; only values under 4 characters are left out.
    expect(result.stderr).toBe("::add-mask::sk-dev-123\n::add-mask::3000");
  });

  test("prints no workflow commands elsewhere", async () => {
    const { envkit } = await project({ env: { CI: "true" } });
    expect((await envkit("get", "API_KEY")).stderr).toBe("");
  });
});

describe("bw calls", () => {
  test("a warm read is a single call", async () => {
    const { envkit, vault } = await project();
    expect(await envkit("get", "API_KEY")).toMatchObject({ code: 0, stdout: "sk-dev-123" });
    expect(vault.calls).toEqual(["getItem item-1"]);
  });

  test("a stale copy adds a sync, and the next read knows it's fresh", async () => {
    const { envkit, vault, sessions } = await project();
    await sessions.save((await sessions.peek())!.key, {
      state: "unlocked",
      serverUrl: SERVER,
      email: ALICE.email,
      userId: undefined,
      lastSync: new Date(Date.now() - 60 * 60_000),
    });
    await envkit("get", "API_KEY");
    expect(vault.calls).toEqual(["sync", "getItem item-1"]);
    vault.calls.length = 0;
    await envkit("get", "API_KEY");
    expect(vault.calls).toEqual(["getItem item-1"]);
  });

  test("falls back to status and unlock when the cached session was invalidated", async () => {
    const { envkit, vault } = await project();
    await vault.unlock(ALICE.password); // e.g. another envkit home or `bw unlock`
    vault.calls.length = 0;
    expect(await envkit("get", "API_KEY")).toMatchObject({ code: 0, stdout: "sk-dev-123" });
    expect(vault.calls).toEqual(["status", "unlock", "getItem item-1"]);
    vault.calls.length = 0;
    await envkit("get", "API_KEY");
    expect(vault.calls).toEqual(["getItem item-1"]);
  });

  test("a write falls back too (`bw sync` works while locked, the read doesn't)", async () => {
    const { envkit, vault } = await project();
    await vault.lock();
    vault.calls.length = 0;
    expect((await envkit("set", "NEW=1")).code).toBe(0);
    expect(vault.calls).toEqual([
      "sync",
      "status",
      "unlock",
      "getItem item-1",
      "updateItem myapp/dev",
    ]);
  });

  test("a cold read checks the status once", async () => {
    const { envkit, vault, sessions } = await project();
    await sessions.clear();
    await vault.lock();
    vault.calls.length = 0;
    await envkit("get", "API_KEY");
    expect(vault.calls).toEqual(["status", "unlock", "getItem item-1"]);
  });
});
