import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { currentSession } from "../session.ts";

export const status = defineCommand({
  meta: {
    name: "status",
    description: "Show the vault server, account and lock state",
  },
  args: {
    json: {
      type: "boolean",
      description: "Print machine-readable JSON",
    },
  },
  async run({ args }) {
    const context = useContext();
    const vault = await context.backend().status();
    const sessions = await context.sessions();
    // Peek without refreshing the idle timeout: checking status isn't "using" the vault.
    const session =
      vault.state === "unauthenticated"
        ? undefined
        : await currentSession(context, vault, { touch: false });
    const state = vault.state === "unauthenticated" ? vault.state : session ? "unlocked" : "locked";
    const expiresAt =
      session && !context.env.ENVKIT_SESSION ? await sessions.expiresAt() : undefined;

    if (args.json) {
      context.output.stdout(
        JSON.stringify({
          state,
          serverUrl: vault.serverUrl ?? null,
          email: vault.email ?? null,
          lastSync: vault.lastSync?.toISOString() ?? null,
          sessionStore: sessions.store.description,
          sessionExpiresAt: expiresAt?.toISOString() ?? null,
        }),
      );
      return;
    }

    const rows: [string, string][] = [
      ["Server", vault.serverUrl ?? "not set"],
      ["Account", vault.email ?? "not logged in"],
      ["Vault", state],
    ];
    if (expiresAt) rows.push(["Locks at", expiresAt.toLocaleTimeString()]);
    if (vault.lastSync) rows.push(["Last sync", vault.lastSync.toLocaleString()]);
    rows.push(["Sessions", sessions.store.description]);
    for (const [label, value] of rows) context.output.stdout(`${`${label}:`.padEnd(11)}${value}`);
  },
});
