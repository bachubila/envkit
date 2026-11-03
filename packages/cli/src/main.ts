import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { lock } from "./commands/lock.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { unlock } from "./commands/unlock.ts";

export const main = defineCommand({
  meta: {
    name: "envkit",
    version: pkg.version,
    description: "Share environment variables with your team through a self-hosted Vaultwarden.",
  },
  subCommands: { login, logout, unlock, lock, status },
});
