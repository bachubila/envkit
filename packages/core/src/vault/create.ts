import { EnvkitError } from "../errors.ts";
import type { Env } from "../paths.ts";
import type { VaultBackend } from "./backend.ts";
import { BwCliBackend } from "./bw-cli.ts";
import { NativeBackend } from "./native/backend.ts";

export const BACKENDS = ["native", "bw"] as const;

/**
 * The vault backend ENVKIT_BACKEND selects: `native` (the default) talks to
 * the server itself; `bw` drives the Bitwarden CLI.
 */
export function createBackend(env: Env, envkitHome: string): VaultBackend {
  const name = env.ENVKIT_BACKEND || "native";
  if (name === "native") return NativeBackend.fromEnv(env, envkitHome);
  if (name === "bw") return BwCliBackend.fromEnv(env, envkitHome);
  throw new EnvkitError(`Unknown ENVKIT_BACKEND "${name}"`, {
    hint: `Use one of: ${BACKENDS.join(", ")}.`,
  });
}
