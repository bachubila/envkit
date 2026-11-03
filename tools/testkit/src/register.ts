import {
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { request } from "node:https";

/**
 * Registers a Bitwarden account on a (test) Vaultwarden server, doing the
 * client-side key derivation and encryption that the web vault normally does.
 * The `bw` CLI can't create accounts, so integration tests use this instead.
 */
export async function registerAccount(
  serverUrl: string,
  account: { email: string; password: string; name?: string },
  /** PEM CA certificate for self-signed test servers. */
  ca?: string,
): Promise<void> {
  const email = account.email.trim().toLowerCase();
  const kdfIterations = 600_000;

  const masterKey = pbkdf2Sync(account.password, email, kdfIterations, 32, "sha256");
  const masterPasswordHash = pbkdf2Sync(masterKey, account.password, 1, 32, "sha256").toString(
    "base64",
  );
  const stretched = Buffer.concat([hkdfExpand(masterKey, "enc"), hkdfExpand(masterKey, "mac")]);

  const userKey = randomBytes(64);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  // Without SMTP configured, Vaultwarden returns the email verification token
  // directly instead of mailing it.
  const emailVerificationToken = await post(
    ca,
    serverUrl,
    "/identity/accounts/register/send-verification-email",
    {
      email,
      name: account.name ?? email,
      receiveMarketingEmails: false,
    },
  );

  await post(ca, serverUrl, "/identity/accounts/register/finish", {
    email,
    emailVerificationToken,
    masterPasswordHash,
    masterPasswordHint: null,
    userSymmetricKey: encryptAesCbcHmac(userKey, stretched),
    userAsymmetricKeys: {
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      encryptedPrivateKey: encryptAesCbcHmac(
        privateKey.export({ type: "pkcs8", format: "der" }),
        userKey,
      ),
    },
    kdf: 0,
    kdfIterations,
  });
}

function post(
  ca: string | undefined,
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, serverUrl),
      { method: "POST", headers: { "content-type": "application/json" }, ca },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(text);
          else reject(new Error(`POST ${path} failed: ${status} ${text.slice(0, 200)}`));
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// HKDF-Expand without the extract step, as Bitwarden uses to stretch the master
// key. One SHA-256 block is exactly the 32 bytes we need: T(1) = HMAC(key, info || 0x01).
function hkdfExpand(key: Buffer, info: string): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

// EncString type 2: AesCbc256_HmacSha256_B64 -> "2.<iv>|<ciphertext>|<mac>"
function encryptAesCbcHmac(plaintext: Buffer, key: Buffer): string {
  const encKey = key.subarray(0, 32);
  const macKey = key.subarray(32, 64);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}
