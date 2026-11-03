import { describe, expect, test } from "vite-plus/test";
import { FakeVault } from "@envkit/testkit";
import { ALICE, harness, SERVER } from "./helpers.ts";

describe("envkit login", () => {
  test("non-interactive login with flags and ENVKIT_PASSWORD", async () => {
    const { envkit, vault } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    const result = await envkit("login", "--server", "vault.example.test/", "--email", ALICE.email);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Logged in as ${ALICE.email} on ${SERVER}.`);
    expect(result.stdout).toContain("ask for your master password on each command");
    expect(vault.calls).toContain(`setServer ${SERVER}`);

    const status = await envkit("status", "--json");
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "unlocked",
      serverUrl: SERVER,
      email: ALICE.email,
    });
  });

  test("interactive login prompts for whatever is missing", async () => {
    const { envkit, prompts } = harness({
      interactive: true,
      persistentStore: true,
      answers: ["https://vault.example.test", ALICE.email, ALICE.password],
    });
    const result = await envkit("login");
    expect(result.code).toBe(0);
    expect(prompts.asked).toEqual(["Vault URL", "Email", "Master password"]);
    expect(result.stdout).toContain("kept in the test keychain and locks after 30 minutes");
  });

  test("ENVKIT_SERVER and ENVKIT_EMAIL work like the flags", async () => {
    const { envkit } = harness({
      env: { ENVKIT_SERVER: SERVER, ENVKIT_EMAIL: ALICE.email, ENVKIT_PASSWORD: ALICE.password },
    });
    expect((await envkit("login")).code).toBe(0);
  });

  test("non-interactive login without details explains what to set", async () => {
    const { envkit } = harness();
    const result = await envkit("login");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Pass --server <url> or set ENVKIT_SERVER.");

    const noPassword = await envkit("login", "--server", SERVER, "--email", ALICE.email);
    expect(noPassword.stderr).toContain("Set ENVKIT_PASSWORD");
  });

  test("rejects http URLs before touching the vault", async () => {
    const { envkit, vault } = harness({ env: { ENVKIT_PASSWORD: "x" } });
    const result = await envkit("login", "--server", "http://localhost:8080", "--email", "a@b");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must use https://");
    expect(vault.calls).toEqual([]);
  });

  test("wrong password", async () => {
    const { envkit } = harness({ env: { ENVKIT_PASSWORD: "wrong" } });
    const result = await envkit("login", "--server", SERVER, "--email", ALICE.email);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Email or master password is incorrect");
  });

  test("API key login, then unlock with the master password", async () => {
    const { envkit, vault } = harness({
      env: {
        BW_CLIENTID: ALICE.clientId!,
        BW_CLIENTSECRET: ALICE.clientSecret!,
        ENVKIT_PASSWORD: ALICE.password,
      },
    });
    const result = await envkit("login", "--server", SERVER, "--apikey");
    expect(result.code).toBe(0);
    expect(vault.calls).toEqual(expect.arrayContaining(["loginWithApiKey", "unlock"]));
    expect(JSON.parse((await envkit("status", "--json")).stdout).state).toBe("unlocked");
  });

  test("--apikey without the key explains where to find it", async () => {
    const { envkit } = harness();
    const result = await envkit("login", "--server", SERVER, "--apikey");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("BW_CLIENTID and BW_CLIENTSECRET");
  });

  test("logging in again to the same account just makes sure it's unlocked", async () => {
    const { envkit, vault } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("login", "--server", SERVER);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain(`Already logged in as ${ALICE.email}`);
    expect(vault.calls).toContain("unlock");
    expect(vault.calls.some((call) => call.startsWith("login"))).toBe(false);
  });

  test("logging in to a different server while logged in asks to log out first", async () => {
    const { envkit, vault } = harness();
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("login", "--server", "https://other.example.test");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Already logged in as ${ALICE.email} on ${SERVER}`);
    expect(result.stderr).toContain("envkit logout");
  });
});

describe("envkit unlock", () => {
  test("not logged in", async () => {
    const { envkit } = harness();
    const result = await envkit("unlock");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not logged in\nRun `envkit login`.");
  });

  test("unlocks with a prompt and caches the session", async () => {
    const { envkit, vault, prompts } = harness({ interactive: true, answers: [ALICE.password] });
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("unlock");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("Vault unlocked.");
    expect(prompts.asked).toEqual([`Master password for ${ALICE.email}`]);

    const again = await envkit("unlock");
    expect(again.stdout).toBe("Vault is already unlocked.");
    expect(prompts.asked).toHaveLength(1);
  });

  test("retries a mistyped password up to three times", async () => {
    const { envkit, vault, prompts } = harness({
      interactive: true,
      answers: ["typo", "typo2", ALICE.password],
    });
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("unlock");
    expect(result.code).toBe(0);
    expect(result.stderr.match(/Incorrect master password, try again/g)).toHaveLength(2);
    expect(prompts.remaining()).toBe(0);
  });

  test("gives up after three wrong passwords", async () => {
    const { envkit, vault } = harness({ interactive: true, answers: ["a", "b", "c"] });
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("unlock");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: Incorrect master password");
  });

  test("non-interactive without ENVKIT_PASSWORD explains the options", async () => {
    const { envkit, vault } = harness();
    vault.seedLogin(SERVER, ALICE.email);
    const result = await envkit("unlock");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("set ENVKIT_PASSWORD");
  });

  test("a cached session invalidated elsewhere (bw lock) is dropped", async () => {
    const { envkit, vault, sessions } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    vault.seedLogin(SERVER, ALICE.email);
    await envkit("unlock");
    await vault.lock();
    expect(JSON.parse((await envkit("status", "--json")).stdout).state).toBe("locked");
    expect(await sessions.store.get()).toBeUndefined();
  });
});

describe("envkit lock / logout", () => {
  test("lock forgets the session and locks bw", async () => {
    const { envkit, vault, sessions } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    vault.seedLogin(SERVER, ALICE.email);
    await envkit("unlock");
    const result = await envkit("lock");
    expect(result).toMatchObject({ code: 0, stdout: "Vault locked." });
    expect(vault.calls).toContain("lock");
    expect(await sessions.store.get()).toBeUndefined();
  });

  test("lock while logged out is harmless", async () => {
    const { envkit, vault } = harness();
    expect((await envkit("lock")).code).toBe(0);
    expect(vault.calls).not.toContain("lock");
  });

  test("logout", async () => {
    const { envkit, vault, sessions } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    vault.seedLogin(SERVER, ALICE.email);
    await envkit("unlock");
    expect(await envkit("logout")).toMatchObject({ code: 0, stdout: "Logged out." });
    expect(await sessions.store.get()).toBeUndefined();
    expect(JSON.parse((await envkit("status", "--json")).stdout).state).toBe("unauthenticated");
  });
});

describe("envkit status", () => {
  test("logged out", async () => {
    const { envkit } = harness();
    const result = await envkit("status");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Server:    not set");
    expect(result.stdout).toContain("Vault:     unauthenticated");
  });

  test("locked vs unlocked, with the lock time", async () => {
    const { envkit, vault } = harness({ env: { ENVKIT_PASSWORD: ALICE.password } });
    vault.seedLogin(SERVER, ALICE.email);
    expect((await envkit("status")).stdout).toContain("Vault:     locked");
    await envkit("unlock");
    const unlocked = await envkit("status");
    expect(unlocked.stdout).toContain(`Account:   ${ALICE.email}`);
    expect(unlocked.stdout).toContain("Vault:     unlocked");
    expect(unlocked.stdout).toContain("Locks at:");
  });

  test("status does not unlock or prompt", async () => {
    const { envkit, vault, prompts } = harness({ interactive: true });
    vault.seedLogin(SERVER, ALICE.email);
    await envkit("status");
    expect(prompts.asked).toEqual([]);
    expect(vault.calls).not.toContain("unlock");
  });

  test("ENVKIT_SESSION is used instead of the cache", async () => {
    const vault = new FakeVault([ALICE]);
    const session = vault.seedLogin(SERVER, ALICE.email, { unlocked: true })!;
    const { envkit } = harness({ vault, env: { ENVKIT_SESSION: session } });
    const result = await envkit("status", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "unlocked", sessionExpiresAt: null });
  });

  test("a stale ENVKIT_SESSION counts as locked", async () => {
    const vault = new FakeVault([ALICE]);
    vault.seedLogin(SERVER, ALICE.email);
    const { envkit } = harness({ vault, env: { ENVKIT_SESSION: "stale" } });
    expect(JSON.parse((await envkit("status", "--json")).stdout).state).toBe("locked");
  });
});
