import * as crypto from "node:crypto";
import { promisify } from "node:util";
import { EnvkitError } from "../../errors.ts";

/**
 * Bitwarden's client-side crypto, as far as envkit needs it: deriving the
 * master key, unwrapping the user and organization keys, and reading and
 * writing encrypted strings ("EncStrings").
 *
 * Symmetric keys are 64 bytes: a 32-byte AES-256 key followed by a 32-byte
 * HMAC-SHA256 key.
 */

const pbkdf2 = promisify(crypto.pbkdf2);

export const KdfType = { Pbkdf2: 0, Argon2id: 1 } as const;

export interface KdfConfig {
  type: number;
  iterations: number;
  /** Argon2id memory in MiB. */
  memory?: number | null;
  parallelism?: number | null;
}

/** Thrown when a MAC doesn't match or a ciphertext can't be decrypted: wrong key or corrupt data. */
export class DecryptionError extends Error {
  override readonly name = "DecryptionError";
}

/**
 * The weakest settings envkit derives a password hash with, as Bitwarden's
 * clients enforce. The server picks the settings at login, so without these a
 * malicious or compromised server could ask for a hash that's cheap to crack.
 */
export const KDF_MINIMUMS = { pbkdf2Iterations: 100_000, argon2Iterations: 2, argon2MemoryMiB: 16 };

export function assertStrongKdf(kdf: KdfConfig): void {
  const weak =
    kdf.type === KdfType.Pbkdf2
      ? kdf.iterations < KDF_MINIMUMS.pbkdf2Iterations
      : kdf.type === KdfType.Argon2id
        ? kdf.iterations < KDF_MINIMUMS.argon2Iterations ||
          (kdf.memory ?? 0) < KDF_MINIMUMS.argon2MemoryMiB ||
          (kdf.parallelism ?? 0) < 1
        : false;
  if (weak) {
    throw new EnvkitError("The server asked for unsafely weak key derivation settings", {
      hint:
        "envkit won't send a password hash derived with them. If this is your server, raise the " +
        "account's KDF settings in the web vault (Account settings → Security → Keys); otherwise " +
        "check that you're logging in to the right server.",
    });
  }
}

/** The 32-byte master key: KDF(master password, email). */
export async function deriveMasterKey(
  password: string,
  email: string,
  kdf: KdfConfig,
): Promise<Buffer> {
  const salt = email.trim().toLowerCase();
  if (kdf.type === KdfType.Pbkdf2) {
    return pbkdf2(password, salt, kdf.iterations, 32, "sha256");
  }
  if (kdf.type === KdfType.Argon2id) return argon2id(password, salt, kdf);
  throw new EnvkitError(`Unsupported key derivation function (${kdf.type})`, {
    hint: "Set ENVKIT_BACKEND=bw to use the Bitwarden CLI instead.",
  });
}

/** What the server stores to check the password: PBKDF2(master key, password, 1). */
export function masterPasswordHash(masterKey: Buffer, password: string): string {
  return crypto.pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64");
}

/** Expands the master key into an encryption and a MAC key (HKDF-Expand, no extract step). */
export function stretchMasterKey(masterKey: Buffer): Buffer {
  return Buffer.concat([hkdfExpand(masterKey, "enc"), hkdfExpand(masterKey, "mac")]);
}

/** Decrypts an AES EncString (type 0 or 2) with a symmetric key. */
export function decrypt(encString: string, key: Buffer): Buffer {
  const { type, parts } = parse(encString);
  if (type === 0) {
    const [iv, data] = parts;
    if (!iv || !data) throw new DecryptionError("Malformed EncString");
    return aesDecrypt(key.subarray(0, 32), iv, data);
  }
  if (type === 2) {
    const [iv, data, mac] = parts;
    if (!iv || !data || !mac || key.length !== 64) throw new DecryptionError("Malformed EncString");
    const expected = hmac(key.subarray(32), iv, data);
    if (!crypto.timingSafeEqual(expected, mac)) throw new DecryptionError("MAC mismatch");
    return aesDecrypt(key.subarray(0, 32), iv, data);
  }
  throw new DecryptionError(`Unsupported EncString type ${type}`);
}

export function decryptText(encString: string, key: Buffer): string {
  return decrypt(encString, key).toString("utf8");
}

/** Encrypts to an EncString of type 2 (AES-256-CBC with HMAC-SHA256). */
export function encrypt(plaintext: Buffer | string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = hmac(key.subarray(32), iv, data);
  return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

/** Decrypts an RSA EncString (type 3: OAEP-SHA256, type 4: OAEP-SHA1) with a PKCS#8 DER private key. */
export function decryptRsa(encString: string, privateKeyDer: Buffer): Buffer {
  const { type, parts } = parse(encString);
  const [data] = parts;
  if ((type !== 3 && type !== 4) || !data) {
    throw new DecryptionError(`Unsupported EncString type ${type}`);
  }
  try {
    const key = crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
    return crypto.privateDecrypt(
      {
        key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: type === 3 ? "sha256" : "sha1",
      },
      data,
    );
  } catch (error) {
    throw new DecryptionError("RSA decryption failed", { cause: error });
  }
}

function parse(encString: string): { type: number; parts: Buffer[] } {
  const dot = encString.indexOf(".");
  const type = Number(encString.slice(0, dot));
  if (dot < 1 || !Number.isInteger(type)) throw new DecryptionError("Malformed EncString");
  return {
    type,
    parts: encString
      .slice(dot + 1)
      .split("|")
      .map((part) => Buffer.from(part, "base64")),
  };
}

function aesDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    throw new DecryptionError("AES decryption failed", { cause: error });
  }
}

function hmac(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(iv).update(data).digest();
}

// One SHA-256 block is exactly the 32 bytes needed: T(1) = HMAC(key, info || 0x01).
function hkdfExpand(key: Buffer, info: string): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

type Argon2 = (
  algorithm: "argon2id",
  parameters: {
    message: string;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, key: Buffer) => void,
) => void;

/** Bitwarden's Argon2id: the salt is SHA-256(email), memory is given in MiB. */
function argon2id(password: string, salt: string, kdf: KdfConfig): Promise<Buffer> {
  // Node 24.7+; @types/node may not declare it yet.
  const argon2 = (crypto as unknown as { argon2?: Argon2 }).argon2;
  if (!argon2) {
    throw new EnvkitError("This account uses Argon2id, which needs Node.js 24.7 or newer", {
      hint: "Upgrade Node.js, or set ENVKIT_BACKEND=bw to use the Bitwarden CLI.",
    });
  }
  return new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message: password,
        nonce: crypto.createHash("sha256").update(salt).digest(),
        parallelism: kdf.parallelism ?? 4,
        tagLength: 32,
        memory: (kdf.memory ?? 64) * 1024,
        passes: kdf.iterations,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
