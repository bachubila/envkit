import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMailpit } from "../src/mailpit.ts";
import { startVaultwarden } from "../src/vaultwarden.ts";
import { VaultwardenApi, type TestAccount } from "../src/vault-api.ts";
import { NativeBackend } from "@envkit/core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server?.stop());

test("native login completes Vaultwarden authenticator verification and rejects non-interactive login", async () => {
  const code = await server.api.enableAuthenticator(server.account);
  const backend = NativeBackend.fromEnv(server.env, await server.tempHome());
  await backend.setServer(server.vaultwarden.url);
  const askCode = vi.fn(async () => code());
  await expect(backend.login({ ...server.account, interactive: false, askCode })).rejects.toThrow(
    "two-step login",
  );
  expect(askCode).not.toHaveBeenCalled();
  const session = await backend.login({ ...server.account, interactive: true, askCode });
  expect(askCode).toHaveBeenCalledWith("authenticator");
  expect(await backend.status(session)).toMatchObject({
    state: "unlocked",
    email: server.account.email,
  });
});

describe("native email two-step login with SMTP", () => {
  let mail: Awaited<ReturnType<typeof startMailpit>>;
  let vault: Awaited<ReturnType<typeof startVaultwarden>>;
  let account: TestAccount;
  let home: string;
  let backend: NativeBackend;
  beforeAll(async () => {
    mail = await startMailpit();
    vault = await startVaultwarden({ network: mail.network, smtpHost: mail.host });
    const api = new VaultwardenApi(vault.url, await readFile(vault.caCertPath, "utf8"));
    account = await api.registerAccount({
      email: "email-login@example.test",
      password: "email verification test password",
    });
    await api.enableEmail(account, () => mail.code(account.email));
    home = await mkdtemp(join(tmpdir(), "envkit-email-login-"));
    backend = NativeBackend.fromEnv({ NODE_EXTRA_CA_CERTS: vault.caCertPath }, home);
    await backend.setServer(vault.url);
  });
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    await vault?.stop();
    await mail?.stop();
  });

  test("non-interactive login never prompts and leaves the account logged out", async () => {
    const askCode = vi.fn(async () => "000000");
    await expect(backend.login({ ...account, interactive: false, askCode })).rejects.toThrow(
      "two-step login",
    );
    expect(askCode).not.toHaveBeenCalled();
    expect(await backend.status()).toMatchObject({ state: "unauthenticated" });
  });

  test("retries a rejected code, accepts the mailed code and never persists either code", async () => {
    const codes: string[] = [];
    const askCode = vi.fn(async () => {
      const actual = codes[0] ?? (await mail.code(account.email));
      codes.push(actual);
      // A guaranteed wrong code on the first attempt.
      return codes.length === 1 ? (actual === "000000" ? "111111" : "000000") : actual;
    });
    const session = await backend.login({ ...account, interactive: true, askCode });
    expect(askCode).toHaveBeenCalledTimes(2);
    expect(askCode).toHaveBeenNthCalledWith(1, "email");
    expect(askCode).toHaveBeenNthCalledWith(2, "email");
    expect(await backend.status(session)).toMatchObject({
      state: "unlocked",
      email: account.email,
    });
    const state = JSON.parse(await readFile(join(home, "vault", "state.json"), "utf8"));
    // Codes must not become state fields. Check serialized string values, rather
    // than substring matches that could coincidentally occur inside ciphertext.
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
    for (const code of codes) expect(strings(state)).not.toContain(code);
  });
});
