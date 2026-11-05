import { describe, expect, test } from "vite-plus/test";
import { githubMaskCommands, isGithubActions } from "../src/index.ts";

describe("githubMaskCommands", () => {
  test("one command per value", () => {
    expect(githubMaskCommands(["sk-123456", "hunter22"])).toEqual([
      "::add-mask::sk-123456",
      "::add-mask::hunter22",
    ]);
  });

  test("masks each line of a multi-line value", () => {
    expect(githubMaskCommands(["-----BEGIN KEY-----\r\nabcd\nefgh\n"])).toEqual([
      "::add-mask::-----BEGIN KEY-----",
      "::add-mask::abcd",
      "::add-mask::efgh",
    ]);
  });

  test("skips short and blank lines, and repeats", () => {
    expect(githubMaskCommands(["", "1", "abc", "    ", "true", "true"])).toEqual([
      "::add-mask::true",
    ]);
  });

  test("escapes % like @actions/core", () => {
    expect(githubMaskCommands(["100%25off"])).toEqual(["::add-mask::100%2525off"]);
  });
});

test("isGithubActions", () => {
  expect(isGithubActions({ GITHUB_ACTIONS: "true" })).toBe(true);
  expect(isGithubActions({ CI: "true" })).toBe(false);
});
