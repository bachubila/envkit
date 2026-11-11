import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FieldType } from "@envkit/core";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

async function project() {
  const env: Record<string, string> = { ENVKIT_PASSWORD: ALICE.password };
  const h = harness({ env });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  expect((await h.envkit("init", "--project", "myapp", "--env", "dev")).code).toBe(0);
  h.vault.items.get("item-1")!.fields = [
    { name: "API_KEY", value: "dev-key", type: FieldType.Hidden },
  ];
  return { ...h, env };
}

describe.skipIf(process.platform !== "win32")("Windows envkit run", () => {
  test("resolves .cmd shims on PATH and preserves arguments, environment, cwd and exit code", async () => {
    const { envkit, cwd, env } = await project();
    const bin = join(cwd, "path with spaces", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const script = join(cwd, "dump.cjs");
    const out = join(cwd, "result.json");
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), key: process.env.API_KEY, cwd: process.cwd() })); process.exit(42);`,
    );
    writeFileSync(
      join(bin, "envkit-test-shim.cmd"),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    // Keep the shim on the child's PATH, as package managers do for their launchers.
    env.PATH = bin;
    const args = ["dev", "two words", "a&b", "a|b", "a>b", "(value)", 'a"b', ""];
    const result = await envkit("run", "--", "envkit-test-shim", ...args);
    expect(result).toMatchObject({ code: 42, stderr: "" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ args, key: "dev-key", cwd });
  });

  test("an unknown command still exits 127 with the envkit diagnostic", async () => {
    const { envkit } = await project();
    const result = await envkit("run", "--", "envkit-no-such-command-xyz");
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("Command not found: envkit-no-such-command-xyz");
  });
});
