import { defineCommand } from "citty";
import { useContext } from "../context.ts";

export const lock = defineCommand({
  meta: {
    name: "lock",
    description: "Lock the vault and forget the cached session",
  },
  async run() {
    const context = useContext();
    const backend = context.backend();
    await (await context.sessions()).clear();
    if ((await backend.status()).state !== "unauthenticated") await backend.lock();
    context.output.stdout("Vault locked.");
  },
});
