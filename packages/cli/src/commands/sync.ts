import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { requireLogin } from "../session.ts";

export const sync = defineCommand({
  meta: {
    name: "sync",
    description: "Download the latest vault data now (envkit also syncs every few minutes)",
  },
  async run() {
    const context = useContext();
    await requireLogin(context);
    // `bw sync` only needs the login, not an unlocked vault.
    await context.backend().sync(context.env.ENVKIT_SESSION ?? "");
    await (await context.sessions()).recordSync();
    context.output.stdout("Synced.");
  },
});
