import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NativeBackend, type LoginOptions } from "../src/index.ts";
import { deriveMasterKey, encrypt, stretchMasterKey } from "../src/vault/native/crypto.ts";
import { HttpError, type HttpRequest } from "../src/vault/native/http.ts";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/vault/native/http.ts", async (original) => ({
  ...(await original<typeof import("../src/vault/native/http.ts")>()),
  send: transport.send,
}));

let home: string;
let backend: NativeBackend;
const options: LoginOptions = {
  email: "alice@example.test",
  password: "test password",
  interactive: true,
};
const kdf = { type: 0, iterations: 100_000 };
const sent: HttpRequest[] = [];
let challenges: Record<string, unknown>[];
let token: Record<string, unknown>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "envkit-login-"));
  backend = NativeBackend.fromEnv({}, home);
  await backend.setServer("https://vault.example.test");
  challenges = [];
  sent.length = 0;
  const master = await deriveMasterKey(options.password, options.email, kdf);
  const claims = Buffer.from(JSON.stringify({ sub: "user-1", email: options.email })).toString(
    "base64url",
  );
  token = {
    access_token: `header.${claims}.signature`,
    expires_in: 3600,
    Kdf: 0,
    KdfIterations: kdf.iterations,
    Key: encrypt(randomBytes(64), stretchMasterKey(master)),
    PrivateKey: "unused",
  };
  transport.send.mockImplementation(async (request: HttpRequest) => {
    // Snapshot forms: later retries must not mutate earlier observations.
    sent.push(structuredClone(request));
    if (request.url.endsWith("/prelogin")) return { kdf: 0, kdfIterations: kdf.iterations };
    if (request.url.endsWith("/connect/token")) {
      const challenge = challenges.shift();
      if (challenge) throw new HttpError(400, "verification required", challenge);
      return token;
    }
    if (request.url.includes("/sync")) return {};
    if (request.url.endsWith("/send-email-login")) return undefined;
    throw new Error("Unexpected request");
  });
});

afterEach(() => rm(home, { recursive: true, force: true }));
const tokenRequests = () => sent.filter((r) => r.url.endsWith("/connect/token"));

describe("native password login verification", () => {
  test("prefers an authenticator and keeps the device, password hash and headers across retries", async () => {
    challenges.push({ TwoFactorProviders2: { "0": null, "1": {} } });
    const askCode = vi.fn(async () => " 123456 ");
    const session = await backend.login({ ...options, askCode });
    expect(askCode).toHaveBeenCalledWith("authenticator");
    const [first, retry] = tokenRequests();
    expect(retry!.form).toEqual({
      ...first!.form,
      twoFactorToken: "123456",
      twoFactorProvider: "0",
      twoFactorRemember: "0",
    });
    expect(retry!.headers).toEqual(first!.headers);
    expect((await backend.status(session)).state).toBe("unlocked");
    expect(await readFile(join(home, "vault", "state.json"), "utf8")).not.toContain("123456");
  });

  test("requests an email code with the hash and device before prompting", async () => {
    challenges.push({ TwoFactorProviders2: { "1": { Email: "a***@example.test" } } });
    const askCode = vi.fn(async () => {
      expect(sent.at(-1)!.url).toMatch(/send-email-login$/);
      return "234567";
    });
    await backend.login({ ...options, askCode });
    expect(askCode).toHaveBeenCalledWith("email");
    const emailRequest = sent.find((r) => r.url.endsWith("/send-email-login"))!;
    const initial = tokenRequests()[0]!.form!;
    expect(emailRequest.json).toEqual({
      email: options.email,
      masterPasswordHash: initial.password,
      deviceIdentifier: initial.deviceIdentifier,
    });
    expect(tokenRequests()[1]!.form).toMatchObject({
      twoFactorProvider: "1",
      twoFactorToken: "234567",
    });
  });

  test("answers the official new-device challenge using newDeviceOtp", async () => {
    challenges.push({ ErrorModel: { Message: "new device verification required" } });
    const askCode = vi.fn(async () => "345678");
    await backend.login({ ...options, askCode });
    expect(askCode).toHaveBeenCalledWith("new-device");
    expect(tokenRequests()[1]!.form).toEqual({
      ...tokenRequests()[0]!.form,
      newDeviceOtp: "345678",
    });
    expect(sent.some((r) => r.url.endsWith("/send-email-login"))).toBe(false);
  });

  test.each([
    { TwoFactorProviders2: { "0": null } },
    { ErrorModel: { Message: "new device verification required" } },
  ])("non-interactive login fails without asking or requesting an email", async (challenge) => {
    challenges.push(challenge);
    const askCode = vi.fn(async () => "code");
    await expect(backend.login({ ...options, interactive: false, askCode })).rejects.toThrow(
      /verification|two-step/,
    );
    expect(askCode).not.toHaveBeenCalled();
    expect(tokenRequests()).toHaveLength(1);
    expect((await backend.status()).state).toBe("unauthenticated");
  });

  test("unsupported providers do not prompt", async () => {
    challenges.push({ TwoFactorProviders2: { "7": {} } });
    const askCode = vi.fn(async () => "code");
    await expect(backend.login({ ...options, askCode })).rejects.toThrow(
      "unsupported in a terminal",
    );
    expect(askCode).not.toHaveBeenCalled();
  });

  test("bounds repeated challenges and sends only one email", async () => {
    challenges.push(...Array.from({ length: 4 }, () => ({ TwoFactorProviders: ["1"] })));
    const askCode = vi.fn(async () => "123456");
    await expect(backend.login({ ...options, askCode })).rejects.toThrow("three attempts");
    expect(askCode).toHaveBeenCalledTimes(3);
    expect(sent.filter((r) => r.url.endsWith("/send-email-login"))).toHaveLength(1);
    expect((await backend.status()).state).toBe("unauthenticated");
  });

  test("empty codes and cancelled prompts never trigger another token request", async () => {
    challenges.push({ TwoFactorProviders2: { "0": null } });
    await expect(backend.login({ ...options, askCode: async () => " " })).rejects.toThrow(
      "No login verification code",
    );
    expect(tokenRequests()).toHaveLength(1);
    challenges.push({ TwoFactorProviders2: { "0": null } });
    await expect(
      backend.login({
        ...options,
        askCode: async () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(tokenRequests()).toHaveLength(2);
  });

  test("ordinary password errors do not prompt", async () => {
    challenges.push({ error: "invalid_grant", error_description: "bad password" });
    const askCode = vi.fn(async () => "code");
    await expect(backend.login({ ...options, askCode })).rejects.toThrow();
    expect(askCode).not.toHaveBeenCalled();
  });
});
