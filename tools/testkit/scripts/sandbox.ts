// A throwaway Vaultwarden to try envkit against: `pnpm sandbox`.
// Starts the server, registers an account with an organization, prints the
// environment to export, and removes everything on Ctrl-C.
import { readFile } from "node:fs/promises";
import { startVaultwarden, VaultwardenApi } from "../src/index.ts";

const email = process.env.SANDBOX_EMAIL ?? "me@example.com";
const password = process.env.SANDBOX_PASSWORD ?? "correct horse battery staple";

console.log("Starting Vaultwarden in Docker…");
const server = await startVaultwarden();
const api = new VaultwardenApi(server.url, await readFile(server.caCertPath, "utf8"));
const account = await api.registerAccount({ email, password });
await api.createOrganization(account, "Sandbox");

console.log(`
Vaultwarden is running at ${server.url}
Account: ${email} / ${password} (organization "Sandbox")

In another terminal:

  export NODE_EXTRA_CA_CERTS=${server.caCertPath}
  export ENVKIT_HOME=$(mktemp -d)   # keep the sandbox apart from your real envkit
  alias envkit="node --conditions=source ${new URL("../../../packages/cli/src/bin.ts", import.meta.url).pathname}"
  envkit login --server ${server.url} --email ${email}

Press Ctrl-C to stop and delete the server.`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
