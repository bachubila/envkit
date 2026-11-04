import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSessionStore } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BW_PATH, cliUser, startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => server?.stop());

async function cliEnv() {
  return {
    ...server.env,
    ENVKIT_HOME: await server.tempHome(),
    ENVKIT_BW_PATH: BW_PATH,
  };
}

describe("envkit CLI against Vaultwarden (in-process)", () => {
  test("login → status → lock → unlock → logout", async () => {
    const alice = await cliUser(server, server.account);
    const state = async () => JSON.parse((await alice.envkit("status", "--json")).stdout).state;

    const login = await alice.envkit(
      "login",
      "--server",
      server.vaultwarden.url,
      "--email",
      server.account.email,
    );
    expect(login).toMatchObject({ code: 0, stderr: "" });
    expect(login.stdout).toContain(`Logged in as ${server.account.email}`);
    expect(await state()).toBe("unlocked");

    expect((await alice.envkit("lock")).code).toBe(0);
    expect(await state()).toBe("locked");

    expect((await alice.envkit("unlock")).stdout).toContain("Vault unlocked.");
    expect(await state()).toBe("unlocked");

    expect((await alice.envkit("logout")).code).toBe(0);
    expect(await state()).toBe("unauthenticated");
  });
});

describe("envkit binary against Vaultwarden (separate processes)", () => {
  const bin = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url));

  test("a login in one process is visible to the next", async () => {
    const env = await cliEnv();
    const envkit = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["--conditions=source", bin, ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
      });

    const login = envkit(
      ["login", "--server", server.vaultwarden.url, "--email", server.account.email],
      { ENVKIT_PASSWORD: server.account.password },
    );
    expect(login.stderr).toBe("");
    expect(login.status).toBe(0);

    try {
      const status = JSON.parse(envkit(["status", "--json"]).stdout);
      expect(status).toMatchObject({
        serverUrl: server.vaultwarden.url,
        email: server.account.email,
      });
      // Sessions survive the process only where an OS keychain is available (not on CI runners).
      const store = await createSessionStore(env.ENVKIT_HOME);
      expect(status.state).toBe(store.persistent ? "unlocked" : "locked");
      expect(status.sessionStore).toBe(store.description);
    } finally {
      // Removes the keychain entry again.
      expect(envkit(["logout"]).status).toBe(0);
    }
  });
});
