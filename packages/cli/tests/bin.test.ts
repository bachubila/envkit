import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

// Runs the real entry point in a child process, the way users invoke it. The
// `source` condition resolves @envkit/core to its TypeScript source, so no
// build is needed first.
function envkit(...args: string[]) {
  return spawnSync(process.execPath, ["--conditions=source", bin, ...args], { encoding: "utf8" });
}

describe("envkit binary", () => {
  test("--version exits 0 and prints the version", () => {
    const result = envkit("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("--help exits 0 and prints usage", () => {
    const result = envkit("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  test("unknown command sets a non-zero exit code", () => {
    const result = envkit("nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command nope");
  });
});
