import { EnvkitError } from "@envkit/core";
import { defineCommand } from "citty";
import { describe, expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import { run, type Output } from "../src/run.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  return { output, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

describe("envkit", () => {
  test.each([["--version"], ["-v"]])("%s prints the package version", async (flag) => {
    const io = capture();
    expect(await run([flag], io.output)).toBe(0);
    expect(io.stdout()).toBe(pkg.version);
    expect(io.stderr()).toBe("");
  });

  test.each([["--help"], ["-h"], []])("%s prints usage", async (...args) => {
    const io = capture();
    expect(await run(args, io.output)).toBe(0);
    expect(io.stdout()).toContain("envkit");
    expect(io.stdout()).toContain("Vaultwarden");
    expect(io.stdout()).toContain("USAGE");
  });

  test("unknown command fails with a hint", async () => {
    const io = capture();
    expect(await run(["nope"], io.output)).toBe(1);
    expect(io.stderr()).toContain('Unknown command "nope"');
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
    expect(await run([], io.output, command)).toBe(3);
    expect(io.stderr()).toBe("error: vault is locked\nRun `envkit unlock`.");
  });

  test("unexpected errors are reported as bugs with exit code 70", async () => {
    const command = defineCommand({
      run() {
        throw new TypeError("boom");
      },
    });
    const io = capture();
    expect(await run([], io.output, command)).toBe(70);
    expect(io.stderr()).toContain("This is a bug");
    expect(io.stderr()).toContain("TypeError: boom");
  });

  test("citty usage errors are shown cleanly", async () => {
    const command = defineCommand({ subCommands: { known: defineCommand({ run() {} }) } });
    const io = capture();
    expect(await run(["other"], io.output, command)).toBe(1);
    expect(io.stderr()).toContain("Unknown command");
    expect(io.stderr()).not.toContain("at ");
  });
});
