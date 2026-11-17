import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkServer, EnvkitError } from "@envkit/core";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

vi.mock("@envkit/core", async (original) => ({
  ...(await original<typeof import("@envkit/core")>()),
  checkServer: vi.fn(async () => {}),
}));
beforeEach(() => {
  vi.mocked(checkServer).mockReset().mockResolvedValue();
});

async function project() {
  const h = harness({ env: { ENVKIT_PASSWORD: ALICE.password }, persistentStore: true });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  expect((await h.envkit("init", "--project", "myapp", "--env", "dev")).code).toBe(0);
  execFileSync("git", ["init", "--quiet", h.cwd]);
  writeFileSync(join(h.cwd, ".gitignore"), ".env\n");
  h.vault.calls.length = 0;
  return h;
}

describe("doctor", () => {
  test("reports a healthy project without reading secrets, syncing or extending the session", async () => {
    const h = await project();
    const before = await h.sessions.peek({ touch: false });
    const result = await h.envkit("doctor", "--json");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check: { state: string }) => check.state === "pass")).toBe(true);
    expect(checkServer).toHaveBeenCalledWith(SERVER, expect.any(Object));
    expect(await h.sessions.peek({ touch: false })).toEqual(before);
    expect(h.vault.calls.every((call) => call === "status")).toBe(true);
    expect(h.prompts.asked).toEqual([]);
  });

  test("fresh setup reports multiple problems without attempting credential login", async () => {
    const h = harness({
      env: {
        ENVKIT_SERVER: SERVER,
        ENVKIT_EMAIL: ALICE.email,
        ENVKIT_PASSWORD: ALICE.password,
      },
      interactive: true,
    });
    const result = await h.envkit("doctor");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[warn] config:");
    expect(result.stdout).toContain("[fail] login:");
    expect(result.stdout).toContain("[warn] session-store:");
    expect(result.stdout).toContain("[warn] gitignore:");
    expect(h.vault.calls).toEqual(["status"]);
    expect(h.prompts.asked).toEqual([]);
  });

  test("uses the project root when invoked from a subdirectory", async () => {
    const h = await project();
    const child = join(h.cwd, "src");
    mkdirSync(child);
    const nested = harness({ cwd: child, vault: h.vault });
    const result = await nested.envkit("doctor", "--json", "--offline");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "config", state: "pass" }),
        expect.objectContaining({ name: "gitignore", state: "pass" }),
      ]),
    );
  });

  test("invalid config does not prevent the other checks", async () => {
    const h = harness();
    writeFileSync(join(h.cwd, ".envkit.json"), '{"password":"never-print-this",');
    const result = await h.envkit("doctor", "--json", "--offline");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "config", state: "fail" }),
        expect.objectContaining({ name: "backend", state: "pass" }),
        expect.objectContaining({ name: "server", state: "fail" }),
      ]),
    );
    expect(result.stdout).not.toContain("never-print-this");
    expect(checkServer).not.toHaveBeenCalled();
  });

  test("backend failure is reported alongside configuration and gitignore checks", async () => {
    const h = await project();
    vi.spyOn(h.vault, "status").mockRejectedValue(new EnvkitError("bw is too old"));
    const result = await h.envkit("doctor", "--json", "--offline");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "backend", state: "fail", hint: "bw is too old" }),
        expect.objectContaining({ name: "login", state: "skip" }),
        expect.objectContaining({ name: "gitignore", state: "pass" }),
      ]),
    );
  });

  test("a locked vault is a warning and never unlocks even with a password configured", async () => {
    const h = await project();
    await h.vault.lock();
    h.vault.calls.length = 0;
    const result = await h.envkit("doctor");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[warn] login: Vault is locked.");
    expect(h.vault.calls).not.toContain("unlock");
  });

  test("TLS failures have actionable hints and offline mode skips the probe", async () => {
    const h = await project();
    vi.mocked(checkServer).mockRejectedValue(
      new EnvkitError("unreachable", {
        hint: "Set NODE_EXTRA_CA_CERTS to your private CA certificate.",
      }),
    );
    const failure = await h.envkit("doctor");
    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain("NODE_EXTRA_CA_CERTS");
    vi.mocked(checkServer).mockClear();
    const offline = await h.envkit("doctor", "--offline");
    expect(offline.code).toBe(0);
    expect(offline.stdout).toContain("[skip] server:");
    expect(checkServer).not.toHaveBeenCalled();
  });

  test("reports project and account server mismatches", async () => {
    const h = await project();
    h.vault.serverUrl = "https://other.example.test";
    const result = await h.envkit("doctor", "--json", "--offline");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: "server-match",
        state: "fail",
      }),
    );
  });

  test("warns when .env is not ignored, and fails when it is already tracked", async () => {
    const h = await project();
    writeFileSync(join(h.cwd, ".gitignore"), "");
    expect((await h.envkit("doctor")).stdout).toContain("[warn] gitignore: .env is not ignored");
    writeFileSync(join(h.cwd, ".env"), "API_KEY=do-not-print");
    execFileSync("git", ["add", ".env"], { cwd: h.cwd });
    // Adding an ignore rule after tracking the file does not protect it.
    writeFileSync(join(h.cwd, ".gitignore"), ".env\n");
    const result = await h.envkit("doctor");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[fail] gitignore: .env is tracked");
    expect(result.stdout).not.toContain("do-not-print");
  });
});
