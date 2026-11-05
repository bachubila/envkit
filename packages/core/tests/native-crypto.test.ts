import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  pbkdf2Sync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  DecryptionError,
  decrypt,
  decryptRsa,
  decryptText,
  deriveMasterKey,
  encrypt,
  KdfType,
  masterPasswordHash,
  stretchMasterKey,
} from "../src/vault/native/crypto.ts";

const key = randomBytes(64);

describe("EncStrings", () => {
  test("type 2 round-trips text and bytes", () => {
    expect(decryptText(encrypt("héllo 👋", key), key)).toBe("héllo 👋");
    const bytes = randomBytes(64);
    expect(decrypt(encrypt(bytes, key), key)).toEqual(bytes);
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  test("a wrong key or a changed byte fails the MAC", () => {
    const encrypted = encrypt("secret", key);
    expect(() => decrypt(encrypted, randomBytes(64))).toThrow(DecryptionError);
    const [iv, data, mac] = encrypted.slice(2).split("|");
    const flipped = Buffer.from(data!, "base64");
    flipped[0]! ^= 1;
    expect(() => decrypt(`2.${iv}|${flipped.toString("base64")}|${mac}`, key)).toThrow(
      "MAC mismatch",
    );
  });

  test("type 0 (legacy, no MAC) decrypts with the first 32 bytes", () => {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
    const data = Buffer.concat([cipher.update("legacy"), cipher.final()]);
    expect(decryptText(`0.${iv.toString("base64")}|${data.toString("base64")}`, key)).toBe(
      "legacy",
    );
  });

  test("malformed and unsupported strings are DecryptionErrors", () => {
    for (const bad of ["", "nope", "2.abc", "7.abc|def", `2.${"A".repeat(24)}|x`]) {
      expect(() => decrypt(bad, key), bad).toThrow(DecryptionError);
    }
  });

  test("RSA types 3 (OAEP-SHA256) and 4 (OAEP-SHA1)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    const secret = randomBytes(64);
    for (const [type, oaepHash] of [
      [3, "sha256"],
      [4, "sha1"],
    ] as const) {
      const data = publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
        secret,
      );
      expect(decryptRsa(`${type}.${data.toString("base64")}`, der)).toEqual(secret);
    }
    expect(() => decryptRsa(`4.${randomBytes(256).toString("base64")}`, der)).toThrow(
      DecryptionError,
    );
    expect(() => decryptRsa(encrypt("x", key), der)).toThrow(DecryptionError);
  });
});

describe("key derivation", () => {
  test("PBKDF2 uses the lowercased email as salt", async () => {
    const kdf = { type: KdfType.Pbkdf2, iterations: 1000 };
    const masterKey = await deriveMasterKey("pw", " Alice@Example.TEST ", kdf);
    expect(masterKey).toEqual(pbkdf2Sync("pw", "alice@example.test", 1000, 32, "sha256"));
    expect(masterPasswordHash(masterKey, "pw")).toBe(
      pbkdf2Sync(masterKey, "pw", 1, 32, "sha256").toString("base64"),
    );
  });

  test("stretching gives a 64-byte key that differs from the master key", () => {
    const stretched = stretchMasterKey(randomBytes(32));
    expect(stretched).toHaveLength(64);
    expect(stretched.subarray(0, 32)).not.toEqual(stretched.subarray(32));
  });

  test("Argon2id is deterministic and salted by email", async () => {
    const kdf = { type: KdfType.Argon2id, iterations: 1, memory: 1, parallelism: 1 };
    const a = await deriveMasterKey("pw", "a@example.test", kdf);
    expect(a).toHaveLength(32);
    expect(await deriveMasterKey("pw", "A@example.test", kdf)).toEqual(a);
    expect(await deriveMasterKey("pw", "b@example.test", kdf)).not.toEqual(a);
  });

  test("an unknown KDF points to the bw backend", async () => {
    await expect(
      deriveMasterKey("pw", "a@example.test", { type: 9, iterations: 1 }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("ENVKIT_BACKEND=bw") });
  });
});
