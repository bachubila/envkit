import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * Directory where envkit keeps its own state: the native backend's `vault/`
 * (account, tokens, encrypted vault copy) or the `bw` backend's private data
 * dir. `ENVKIT_HOME` overrides it, which tests rely on.
 */
export function envkitHome(env: Env = process.env, platform = process.platform): string {
  if (env.ENVKIT_HOME) return env.ENVKIT_HOME;
  const home = env.HOME ?? homedir();
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "envkit");
  if (platform === "darwin") return join(home, "Library", "Application Support", "envkit");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "envkit");
}
