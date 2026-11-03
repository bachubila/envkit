import { describe, expect, test } from "vite-plus/test";
import { envkitHome, normalizeServerUrl } from "../src/index.ts";

describe("normalizeServerUrl", () => {
  test.each([
    ["https://vault.example.com", "https://vault.example.com"],
    ["https://vault.example.com/", "https://vault.example.com"],
    ["  vault.example.com  ", "https://vault.example.com"],
    ["https://example.com/vault/", "https://example.com/vault"],
    ["https://localhost:8443", "https://localhost:8443"],
  ])("%j → %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  test("rejects plain http because bw refuses it", () => {
    expect(() => normalizeServerUrl("http://localhost:8080")).toThrow(
      "The vault URL must use https://",
    );
  });

  test("rejects garbage", () => {
    expect(() => normalizeServerUrl("https://")).toThrow("Invalid vault URL");
  });
});

describe("envkitHome", () => {
  test("ENVKIT_HOME wins", () => {
    expect(envkitHome({ ENVKIT_HOME: "/custom" }, "linux")).toBe("/custom");
  });

  test.each([
    ["linux", { HOME: "/home/a" }, "/home/a/.config/envkit"],
    ["linux", { HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }, "/xdg/envkit"],
    ["darwin", { HOME: "/Users/a" }, "/Users/a/Library/Application Support/envkit"],
  ] as const)("%s %j", (platform, env, expected) => {
    expect(envkitHome(env, platform)).toBe(expected);
  });
});
