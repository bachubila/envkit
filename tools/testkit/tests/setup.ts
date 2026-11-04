import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BwCliBackend, MemorySessionStore, SessionManager } from "@envkit/core";
import { run } from "../../../packages/cli/src/run.ts";
import {
  startVaultwarden,
  VaultwardenApi,
  type TestAccount,
  type Vaultwarden,
} from "../src/index.ts";

/** The `bw` from this package's devDependencies, so tests pin the version they run against. */
export const BW_PATH = fileURLToPath(new URL("../node_modules/.bin/bw", import.meta.url));
const BIN = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url));

export interface TestServer {
  vaultwarden: Vaultwarden;
  api: VaultwardenApi;
  /** A registered account without any organization. */
  account: TestAccount;
  /** Env for anything that runs `bw` against the self-signed server. */
  env: Record<string, string | undefined>;
  tempHome(): Promise<string>;
  stop(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const vaultwarden = await startVaultwarden();
  const api = new VaultwardenApi(vaultwarden.url, await readFile(vaultwarden.caCertPath, "utf8"));
  const account = await api.registerAccount({
    email: "alice@example.test",
    password: "correct horse battery staple",
  });
  const homes: string[] = [];
  return {
    vaultwarden,
    api,
    account,
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
      await vaultwarden.stop();
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
    ENVKIT_BW_PATH: BW_PATH,
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
      const backend = BwCliBackend.fromEnv(env, env.ENVKIT_HOME);
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
