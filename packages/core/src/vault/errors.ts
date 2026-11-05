import { EnvkitError } from "../errors.ts";

/**
 * A failed vault operation, translated into an actionable message where we
 * know one. `vaultMessage` is the raw message in `bw`'s wording, which both
 * backends use, so callers can match on it ("Vault is locked.", "Not found.").
 */
export class VaultError extends EnvkitError {
  readonly vaultMessage: string;

  constructor(vaultMessage: string, message: string, hint?: string) {
    super(message, { hint });
    this.vaultMessage = vaultMessage;
  }
}

/** Maps a raw message to a VaultError; unknown messages keep `source` as a prefix. */
export function toError(vaultMessage: string, detail?: string, source = "bw"): VaultError {
  const known: [RegExp, string, string?][] = [
    [/^Vault is locked/, "Vault is locked", "Run `envkit unlock`."],
    [/^You are not logged in/, "Not logged in", "Run `envkit login`."],
    [
      /^You are already logged in as (.+?)\.?$/,
      "Already logged in as $1",
      "Run `envkit logout` first.",
    ],
    [
      /^Username or password is incorrect/,
      "Email or master password is incorrect",
      "Check both and try again.",
    ],
    [/decryption operation failed|Invalid master password/i, "Incorrect master password"],
    [/^Not found/, "Item not found in the vault"],
    [
      /^You do not have permission to edit this item/,
      "You can only read this environment",
      "Ask an organization admin for edit access to its collection.",
    ],
    [
      /^Logout required before server config update/,
      "Cannot change server while logged in",
      "Run `envkit logout` first.",
    ],
    [/Insecure URL not allowed/, "The vault URL must use https://"],
  ];
  if (/client copy of this cipher is out of date/i.test(vaultMessage)) return conflictError();
  for (const [pattern, message, hint] of known) {
    const match = pattern.exec(vaultMessage);
    if (match) return new VaultError(vaultMessage, message.replace("$1", match[1] ?? ""), hint);
  }
  return new VaultError(vaultMessage, `${source}: ${vaultMessage}`, detail);
}

export const CONFLICT_MESSAGE = "This environment changed since envkit read it";

export function conflictError(): VaultError {
  return new VaultError(
    "conflict",
    CONFLICT_MESSAGE,
    "Someone else saved it in the meantime. Run the command again to apply your change on top of theirs.",
  );
}

/** Reading an item that's in the trash; matched like a missing item ("Not found."). */
export function trashedError(): VaultError {
  return new VaultError(
    "Not found.",
    "Item is in the vault's trash",
    "Restore it in the web vault.",
  );
}
