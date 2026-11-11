import {
  constants,
  createCipheriv,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  pbkdf2Sync,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { request } from "node:https";

/**
 * Just enough of the Bitwarden client API to set up integration-test fixtures
 * that `bw` can't create: accounts, organizations and confirmed members. It
 * does the client-side key handling the web vault normally does.
 */
export class VaultwardenApi {
  readonly url: string;
  readonly #ca: string | undefined;

  /** `ca` is the PEM certificate for self-signed test servers. */
  constructor(url: string, ca?: string) {
    this.url = url;
    this.#ca = ca;
  }

  async registerAccount(input: { email: string; password: string }): Promise<TestAccount> {
    const email = input.email.trim().toLowerCase();
    const kdfIterations = 600_000;
    const masterKey = pbkdf2Sync(input.password, email, kdfIterations, 32, "sha256");
    const masterPasswordHash = pbkdf2Sync(masterKey, input.password, 1, 32, "sha256").toString(
      "base64",
    );
    const stretched = Buffer.concat([hkdfExpand(masterKey, "enc"), hkdfExpand(masterKey, "mac")]);
    const userKey = randomBytes(64);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });

    // Without SMTP configured, Vaultwarden returns the email verification token
    // directly instead of mailing it.
    const emailVerificationToken = await this.#send(
      "POST",
      "/identity/accounts/register/send-verification-email",
      { json: { email, name: email, receiveMarketingEmails: false } },
    );
    await this.#send("POST", "/identity/accounts/register/finish", {
      json: {
        email,
        emailVerificationToken,
        masterPasswordHash,
        masterPasswordHint: null,
        userSymmetricKey: encryptAesCbcHmac(userKey, stretched),
        userAsymmetricKeys: {
          publicKey: publicKeyDer.toString("base64"),
          encryptedPrivateKey: encryptAesCbcHmac(
            privateKey.export({ type: "pkcs8", format: "der" }),
            userKey,
          ),
        },
        kdf: 0,
        kdfIterations,
      },
    });
    return { email, password: input.password, masterPasswordHash, publicKeyDer };
  }

  /** Enables TOTP for a disposable test account and returns a fresh code generator. */
  async enableAuthenticator(account: TestAccount): Promise<() => string> {
    const response = await this.#api<{
      authenticator: { key: string };
      userVerificationToken: string;
    }>(account, "POST", "/api/two-factor/get-authenticator", {
      masterPasswordHash: account.masterPasswordHash,
    });
    const key = response.authenticator.key;
    await this.#api(account, "POST", "/api/two-factor/authenticator", {
      key,
      token: totp(key),
      userVerificationToken: response.userVerificationToken,
    });
    // Activation consumes the current code. Vaultwarden accepts the next step
    // too, so tests need not sleep until the next 30-second window.
    return () => totp(key, Date.now() + 30_000);
  }

  /** Creates a free organization owned by `owner`, with no collections. */
  async createOrganization(owner: TestAccount, name: string): Promise<TestOrganization> {
    const key = randomBytes(64);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const response = await this.#api<{ id: string }>(owner, "POST", "/api/organizations", {
      name,
      billingEmail: owner.email,
      planType: 0,
      key: encryptRsaOaep(key, owner.publicKeyDer),
      keys: {
        publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        encryptedPrivateKey: encryptAesCbcHmac(
          privateKey.export({ type: "pkcs8", format: "der" }),
          key,
        ),
      },
      collectionName: encryptAesCbcHmac(Buffer.from("Default collection"), key),
    });
    return { id: response.id, name, key };
  }

  /**
   * Invites `member` to the organization with access to `collectionIds`, then
   * confirms them by sharing the organization key, as an admin would.
   */
  async addMember(
    owner: TestAccount,
    organization: TestOrganization,
    member: TestAccount,
    options: { type?: OrganizationUserType; collectionIds?: string[]; readOnly?: boolean } = {},
  ): Promise<void> {
    await this.#api(owner, "POST", `/api/organizations/${organization.id}/users/invite`, {
      emails: [member.email],
      type: options.type ?? OrganizationUserType.User,
      accessAll: false,
      groups: [],
      permissions: {},
      collections: (options.collectionIds ?? []).map((id) => ({
        id,
        readOnly: options.readOnly ?? false,
        hidePasswords: false,
        manage: false,
      })),
    });
    const users = await this.#api<{ data: { id: string; email: string }[] }>(
      owner,
      "GET",
      `/api/organizations/${organization.id}/users`,
    );
    const invited = users.data.find((user) => user.email === member.email);
    if (!invited) throw new Error(`${member.email} was not invited`);
    // Vaultwarden auto-accepts invites for existing users when mail is disabled.
    await this.#api(
      owner,
      "POST",
      `/api/organizations/${organization.id}/users/${invited.id}/confirm`,
      { key: encryptRsaOaep(organization.key, member.publicKeyDer) },
    );
  }

  /** The account's personal API key, as BW_CLIENTID / BW_CLIENTSECRET for `bw login --apikey`. */
  async apiKey(account: TestAccount): Promise<{ clientId: string; clientSecret: string }> {
    const profile = await this.#api<{ id: string }>(account, "GET", "/api/accounts/profile");
    const key = await this.#api<{ apiKey: string }>(account, "POST", "/api/accounts/api-key", {
      masterPasswordHash: account.masterPasswordHash,
    });
    return { clientId: `user.${profile.id}`, clientSecret: key.apiKey };
  }

  async #api<T = unknown>(
    account: TestAccount,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<T> {
    account.accessToken ??= await this.#login(account);
    const text = await this.#send(method, path, {
      json,
      headers: { authorization: `Bearer ${account.accessToken}` },
    });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async #login(account: TestAccount): Promise<string> {
    const text = await this.#send("POST", "/identity/connect/token", {
      form: {
        grant_type: "password",
        username: account.email,
        password: account.masterPasswordHash,
        scope: "api offline_access",
        client_id: "web",
        deviceType: "10",
        deviceIdentifier: randomUUID(),
        deviceName: "envkit-testkit",
      },
    });
    return (JSON.parse(text) as { access_token: string }).access_token;
  }

  #send(
    method: string,
    path: string,
    body: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<string> {
    const payload = body.form
      ? new URLSearchParams(body.form).toString()
      : body.json === undefined
        ? undefined
        : JSON.stringify(body.json);
    const contentType = body.form ? "application/x-www-form-urlencoded" : "application/json";
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, this.url),
        { method, headers: { "content-type": contentType, ...body.headers }, ca: this.#ca },
        (res) => {
          let text = "";
          res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(text);
            else reject(new Error(`${method} ${path} failed: ${status} ${text.slice(0, 300)}`));
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }
}

export interface TestAccount {
  email: string;
  password: string;
  masterPasswordHash: string;
  publicKeyDer: Buffer;
  accessToken?: string;
}

export interface TestOrganization {
  id: string;
  name: string;
  /** The organization's symmetric key (64 bytes: encryption + MAC). */
  key: Buffer;
}

export const OrganizationUserType = { Owner: 0, Admin: 1, User: 2, Manager: 3 } as const;
export type OrganizationUserType = (typeof OrganizationUserType)[keyof typeof OrganizationUserType];

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

// EncString type 4: Rsa2048_OaepSha1_B64 -> "4.<ciphertext>"
function encryptRsaOaep(plaintext: Buffer, publicKeyDer: Buffer): string {
  const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  const ciphertext = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    plaintext,
  );
  return `4.${ciphertext.toString("base64")}`;
}

/** RFC 6238 SHA-1, six digits; only for disposable integration-test accounts. */
function totp(base32: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid test authenticator key");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
