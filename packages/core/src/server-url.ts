import { EnvkitError } from "./errors.ts";

/**
 * Normalizes a user-entered vault URL: adds `https://` when no scheme is given
 * and drops trailing slashes. Plain http is rejected because `bw` refuses it.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new EnvkitError(`Invalid vault URL "${input}"`, {
      hint: "Use the address you open the web vault at, e.g. https://vault.example.com",
    });
  }
  if (url.protocol !== "https:") {
    throw new EnvkitError("The vault URL must use https://", {
      hint: "The Bitwarden CLI refuses plain-http servers, including localhost.",
    });
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
