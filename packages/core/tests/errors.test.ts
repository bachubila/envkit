import { describe, expect, test } from "vite-plus/test";
import { EnvkitError, isEnvkitError } from "../src/index.ts";

describe("EnvkitError", () => {
  test("defaults to exit code 1 and no hint", () => {
    const error = new EnvkitError("vault is locked");
    expect(error.message).toBe("vault is locked");
    expect(error.name).toBe("EnvkitError");
    expect(error.exitCode).toBe(1);
    expect(error.hint).toBeUndefined();
  });

  test("keeps hint, exit code and cause", () => {
    const cause = new Error("spawn bw ENOENT");
    const error = new EnvkitError("bw not found", { hint: "install it", exitCode: 127, cause });
    expect(error.hint).toBe("install it");
    expect(error.exitCode).toBe(127);
    expect(error.cause).toBe(cause);
  });

  test("isEnvkitError tells expected failures from bugs", () => {
    expect(isEnvkitError(new EnvkitError("x"))).toBe(true);
    expect(isEnvkitError(new Error("x"))).toBe(false);
    expect(isEnvkitError("x")).toBe(false);
  });
});
