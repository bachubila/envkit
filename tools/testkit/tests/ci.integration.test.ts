import { spawnSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, type EnvkitConfig } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BACKEND_ENV, cliUser, startTestServer, type TestServer } from "./setup.ts";

const BIN = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url));

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => server?.stop());

describe("CI: a fresh runner with only env vars", () => {
  let alice: Awaited<ReturnType<typeof cliUser>>;
  let runner: { cwd: string; env: Record<string, string | undefined> };

  test("set up: Alice's project and a read-only CI account with an API key", async () => {
    const acme = await server.api.createOrganization(server.account, "Acme");
    alice = await cliUser(server, server.account);
    await alice.login();
    expect((await alice.envkit("init", "--project", "myapp", "--env", "dev")).code).toBe(0);
    expect((await alice.envkit("set", "API_KEY=sk-ci-123456", "PORT=3000")).code).toBe(0);
    const config: EnvkitConfig = JSON.parse(await readFile(join(alice.cwd, CONFIG_FILE), "utf8"));

    const ci = await server.register("ci");
    await server.api.addMember(server.account, acme, ci, {
      collectionIds: [config.environments.dev!.collectionId],
      readOnly: true,
    });
    const { clientId, clientSecret } = await server.api.apiKey(ci);

    // The checked-out repo: only .envkit.json, which says which server to use.
    const cwd = await server.tempHome();
    await copyFile(join(alice.cwd, CONFIG_FILE), join(cwd, CONFIG_FILE));
    runner = {
      cwd,
      env: {
        ...server.env,
        ENVKIT_HOME: await server.tempHome(),
        ...BACKEND_ENV,
        // Runners have no keychain; keep this machine's out of it.
        ENVKIT_SESSION_STORE: "memory",
        CI: "true",
        GITHUB_ACTIONS: "true",
        BW_CLIENTID: clientId,
        BW_CLIENTSECRET: clientSecret,
        ENVKIT_PASSWORD: ci.password,
      },
    };
  });

  const envkit = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, ["--conditions=source", BIN, ...args], {
      cwd: runner.cwd,
      env: { ...runner.env, ...env },
      encoding: "utf8",
    });

  test("envkit run logs in, unlocks, masks the values and runs the command", () => {
    const result = envkit([
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.API_KEY, process.env.PORT)",
    ]);
    expect(result.stdout).toBe("sk-ci-123456 3000\n");
    const stderr = result.stderr.split("\n");
    expect(stderr[0]).toMatch(/^Logged in as ci-.*@example\.test on https:\/\/localhost:\d+\.$/);
    expect(stderr).toEqual(expect.arrayContaining(["::add-mask::sk-ci-123456"]));
    expect(result.status).toBe(0);
  });

  test("later steps reuse the login and only unlock", () => {
    const result = envkit(["get", "API_KEY"]);
    expect(result.stdout).toBe("sk-ci-123456\n");
    expect(result.stderr).not.toContain("Logged in");
    expect(result.status).toBe(0);
  });

  test("without ENVKIT_PASSWORD it fails fast instead of prompting", () => {
    const result = envkit(["get", "API_KEY"], { ENVKIT_PASSWORD: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "error: Vault is locked\nRun `envkit unlock` in a terminal, or set ENVKIT_PASSWORD.\n",
    );
  });

  test("the read-only CI account can't change anything", () => {
    const result = envkit(["set", "API_KEY=evil"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: You can only read this environment");
  });
});

describe("cached sessions against a real vault", () => {
  test("a warm read trusts the cached session, and one the vault rejects falls back to unlocking", async () => {
    const account = await server.register("dana");
    await server.api.createOrganization(account, "Dana's");
    const dana = await cliUser(server, account);
    await dana.login();
    expect((await dana.envkit("init", "--project", "solo", "--env", "dev")).code).toBe(0);
    expect((await dana.envkit("set", "TOKEN=abc123")).code).toBe(0);

    let started = performance.now();
    expect((await dana.envkit("get", "TOKEN")).stdout).toBe("abc123");
    const warm = performance.now() - started;

    // Unlocking elsewhere invalidates the session envkit cached.
    await dana.backend();
    started = performance.now();
    const fallback = await dana.envkit("get", "TOKEN");
    const cold = performance.now() - started;
    expect(fallback).toMatchObject({ code: 0, stdout: "abc123", stderr: "" });
    console.log(`warm get: ${Math.round(warm)} ms, after invalidation: ${Math.round(cold)} ms`);
    expect(warm).toBeLessThan(cold);
  });
});
