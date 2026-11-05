import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { diff } from "./commands/diff.ts";
import { env } from "./commands/env.ts";
import { get } from "./commands/get.ts";
import { init } from "./commands/init.ts";
import { link } from "./commands/link.ts";
import { list } from "./commands/list.ts";
import { lock } from "./commands/lock.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { pull } from "./commands/pull.ts";
import { push } from "./commands/push.ts";
import { runCommand } from "./commands/run.ts";
import { set, unset } from "./commands/set.ts";
import { status } from "./commands/status.ts";
import { sync } from "./commands/sync.ts";
import { unlock } from "./commands/unlock.ts";

export const main = defineCommand({
  meta: {
    name: "envkit",
    version: pkg.version,
    description: "Share environment variables with your team through a self-hosted Vaultwarden.",
  },
  args: {
    // Handled by run() for every command; listed here for `envkit --help`.
    "non-interactive": {
      type: "boolean",
      description: "Never prompt; fail with a hint instead (the default when CI is set)",
    },
  },
  subCommands: {
    run: runCommand,
    pull,
    get,
    list,
    set,
    unset,
    push,
    diff,
    init,
    link,
    env,
    sync,
    login,
    logout,
    unlock,
    lock,
    status,
  },
});
