// Release check: drives an installed envkit binary through a full flow
// against a throwaway Vaultwarden. Pack and install it first:
//   cd packages/cli && pnpm pack --pack-destination /tmp/envkit-pack
//   npm install --global --prefix /tmp/envkit-prefix /tmp/envkit-pack/envkit-*.tgz
//   node --conditions=source tools/testkit/scripts/smoke-tarball.ts /tmp/envkit-prefix/bin/envkit
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVaultwarden, VaultwardenApi } from "../src/index.ts";

const bin = process.argv[2]!;
const server = await startVaultwarden();
try {
  const api = new VaultwardenApi(server.url, await readFile(server.caCertPath, "utf8"));
  const password = "correct horse battery staple";
  const account = await api.registerAccount({ email: "smoke@example.test", password });
  await api.createOrganization(account, "Smoke");
  const cwd = await mkdtemp(join(tmpdir(), "smoke-"));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_EXTRA_CA_CERTS: server.caCertPath,
    ENVKIT_HOME: await mkdtemp(join(tmpdir(), "smoke-home-")),
    ENVKIT_SESSION_STORE: "memory",
    ENVKIT_PASSWORD: password,
  };
  const envkit = (...args: string[]) => {
    try {
      const out = execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
      console.log(`$ envkit ${args.join(" ")}\n${out.trim()}`);
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      console.log(`$ envkit ${args.join(" ")}  [exit ${e.status}]\n${e.stdout}${e.stderr}`.trim());
    }
  };
  envkit("login", "--server", server.url, "--email", account.email);
  envkit("init", "--project", "smoke", "--env", "dev,prod");
  envkit("set", "API_KEY=sk-smoke", "PORT=3000", "NODE_OPTIONS=--require /tmp/evil.js");
  envkit("get", "API_KEY");
  envkit("list");
  envkit(
    "run",
    "--",
    "node",
    "-e",
    "console.log(process.env.API_KEY, process.env.PORT, process.env.NODE_OPTIONS ?? 'no NODE_OPTIONS')",
  );
  envkit("pull", "--format", "dotenv");
  envkit("status");
} finally {
  await server.stop();
}
