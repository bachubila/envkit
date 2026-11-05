import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createBackend, MemorySessionStore, SessionManager } from "@envkit/core";
import { run } from "../../../packages/cli/src/run.ts";
import { randomUUID } from "node:crypto";
import { inject } from "vite-plus/test";
import { VaultwardenApi, type TestAccount } from "../src/index.ts";

/** The `bw` from this package's devDependencies, so tests pin the version they run against. */
export const BW_PATH = fileURLToPath(new URL("../node_modules/.bin/bw", import.meta.url));

/**
 * The backend envkit uses in these tests: ENVKIT_BACKEND from the test run
 * (`native` by default). With the native backend `bw` points nowhere, so any
 * command that still spawned it would fail.
 */
export const BACKEND_ENV = {
  ENVKIT_BACKEND: process.env.ENVKIT_BACKEND || "native",
  ENVKIT_BW_PATH: process.env.ENVKIT_BACKEND === "bw" ? BW_PATH : "/nonexistent/bw",
};
const BIN = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url));

export interface TestServer {
  /** The Vaultwarden started once per run by global-setup.ts. */
  vaultwarden: { url: string; caCertPath: string };
  api: VaultwardenApi;
  /** A registered account without any organization. */
  account: TestAccount;
  /** Registers another account. Emails are unique per call, since the server is shared. */
  register(name: string, password?: string): Promise<TestAccount>;
  /** Env for anything that runs `bw` against the self-signed server. */
  env: Record<string, string | undefined>;
  tempHome(): Promise<string>;
  /** Removes this file's temp dirs; the server itself outlives it. */
  stop(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const vaultwarden = inject("vaultwarden");
  const api = new VaultwardenApi(vaultwarden.url, await readFile(vaultwarden.caCertPath, "utf8"));
  const register = (name: string, password = `${name}'s password`) =>
    api.registerAccount({ email: `${name}-${randomUUID().slice(0, 8)}@example.test`, password });
  const account = await register("alice", "correct horse battery staple");
  const homes: string[] = [];
  return {
    vaultwarden,
    api,
    account,
    register,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_EXTRA_CA_CERTS: vaultwarden.caCertPath,
    },
    async tempHome() {
      const home = await mkdtemp(join(tmpdir(), "envkit-it-home-"));
      homes.push(home);
      return home;
    },
    async stop() {
      await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
    },
  };
}

/**
 * Runs envkit in-process as one user on one machine: its own ENVKIT_HOME (so
 * its own `bw` login) and a project directory. Sessions live in memory, so
 * `ENVKIT_PASSWORD` unlocks whenever needed.
 */
export async function cliUser(
  server: TestServer,
  account: { email: string; password: string },
  cwd?: string,
) {
  const env = {
    ...server.env,
    ENVKIT_HOME: await server.tempHome(),
    ...BACKEND_ENV,
    ENVKIT_PASSWORD: account.password,
  };
  const sessions = new SessionManager(new MemorySessionStore());
  const user = {
    env,
    cwd: cwd ?? (await server.tempHome()),
    async envkit(...args: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(args, {
        env,
        cwd: user.cwd,
        interactive: false,
        sessions: async () => sessions,
        output: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      });
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    },
    /** The real binary in a child process (sessions kept in memory, so no keychain entries). */
    spawn(...args: string[]) {
      return spawnSync(process.execPath, ["--conditions=source", BIN, ...args], {
        cwd: user.cwd,
        env: { ...env, ENVKIT_SESSION_STORE: "memory" },
        encoding: "utf8",
      });
    },
    /** A backend logged in as this user, for setting up vault data directly. */
    async backend() {
      const backend = createBackend(env, env.ENVKIT_HOME);
      const session = await backend.unlock(account.password);
      return { backend, session };
    },
    async login() {
      const result = await user.envkit(
        "login",
        "--server",
        server.vaultwarden.url,
        "--email",
        account.email,
      );
      if (result.code !== 0) throw new Error(`login failed: ${result.stderr}`);
    },
  };
  return user;
}
