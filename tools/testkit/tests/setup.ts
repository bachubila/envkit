import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAccount, startVaultwarden, type Vaultwarden } from "../src/index.ts";

/** The `bw` from this package's devDependencies, so tests pin the version they run against. */
export const BW_PATH = fileURLToPath(new URL("../node_modules/.bin/bw", import.meta.url));

export interface TestServer {
  vaultwarden: Vaultwarden;
  account: { email: string; password: string };
  /** Env for anything that runs `bw` against the self-signed server. */
  env: Record<string, string | undefined>;
  tempHome(): Promise<string>;
  stop(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const vaultwarden = await startVaultwarden();
  const account = { email: "alice@example.test", password: "correct horse battery staple" };
  await registerAccount(vaultwarden.url, account, await readFile(vaultwarden.caCertPath, "utf8"));
  const homes: string[] = [];
  return {
    vaultwarden,
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
