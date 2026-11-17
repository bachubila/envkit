import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import type { Env } from "./paths.ts";

/** Node loads NODE_EXTRA_CA_CERTS at startup; embedders may supply it later. */
export function extraCa(env: Env): string[] | undefined {
  const path = env.NODE_EXTRA_CA_CERTS;
  if (!path || path === process.env.NODE_EXTRA_CA_CERTS) return undefined;
  try {
    return [...rootCertificates, readFileSync(path, "utf8")];
  } catch {
    return undefined;
  }
}
