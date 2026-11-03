import { EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import { describe, expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import { run } from "../src/run.ts";
import type { Output } from "../src/context.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
  return { output, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

describe("envkit", () => {
  test.each([["--version"], ["-v"]])("%s prints the package version", async (flag) => {
    const io = capture();
    expect(await run([flag], { output: io.output })).toBe(0);
    expect(io.stdout()).toBe(pkg.version);
    expect(io.stderr()).toBe("");
  });

  test.each([["--help"], ["-h"], []])("%s prints usage with the command list", async (...args) => {
    const io = capture();
    expect(await run(args, { output: io.output })).toBe(0);
    expect(io.stdout()).toContain("USAGE");
    for (const command of ["login", "logout", "unlock", "lock", "status"]) {
      expect(io.stdout()).toContain(command);
    }
  });

  test("subcommand --help shows that command's options", async () => {
    const io = capture();
    expect(await run(["login", "--help"], { output: io.output })).toBe(0);
    expect(io.stdout()).toContain("envkit login");
    expect(io.stdout()).toContain("--server");
    expect(io.stdout()).toContain("--apikey");
  });

  test("unknown command fails with a hint", async () => {
    const io = capture();
    expect(await run(["nope"], { output: io.output })).toBe(1);
    expect(io.stderr()).toContain("Unknown command");
    expect(io.stderr()).toContain("nope");
    expect(io.stderr()).toContain("envkit --help");
    expect(io.stdout()).toBe("");
  });
});

describe("error handling", () => {
  test("EnvkitError prints message and hint without a stack trace", async () => {
    const command = defineCommand({
      run() {
        throw new EnvkitError("vault is locked", { hint: "Run `envkit unlock`.", exitCode: 3 });
      },
    });
    const io = capture();
    expect(await run(["go"], { output: io.output }, command)).toBe(3);
    expect(io.stderr()).toBe("error: vault is locked\nRun `envkit unlock`.");
  });

  test("unexpected errors are reported as bugs with exit code 70", async () => {
    const command = defineCommand({
      run() {
        throw new TypeError("boom");
      },
    });
    const io = capture();
    expect(await run(["go"], { output: io.output }, command)).toBe(70);
    expect(io.stderr()).toContain("This is a bug");
    expect(io.stderr()).toContain("TypeError: boom");
  });
});
