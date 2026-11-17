import { EnvkitError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { normalizeServerUrl } from "./server-url.ts";
import { extraCa } from "./tls.ts";
import { CLIENT_HEADERS } from "./vault/native/protocol.ts";
import { send } from "./vault/native/http.ts";

/** Unauthenticated, TLS-verified probe. Never sends vault credentials or follows redirects. */
export async function checkServer(server: string, env: Env): Promise<void> {
  const response = await send<{ version?: unknown } | undefined>(
    {
      method: "GET",
      url: `${normalizeServerUrl(server)}/api/config`,
      timeoutMs: 5000,
      headers: CLIENT_HEADERS,
    },
    extraCa(env),
  );
  if (typeof response?.version !== "string") {
    throw new EnvkitError("The server did not return a Bitwarden-compatible configuration", {
      hint: "Check your vault URL and any reverse proxy configuration.",
    });
  }
}
