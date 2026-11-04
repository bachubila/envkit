import { describe, expect, test } from "vite-plus/test";
import {
  canCreateCollections,
  environmentItemName,
  environmentItemNotes,
  ITEM_MARKER,
  parseEnvironmentItem,
  validateEnvironmentName,
  validateProjectName,
} from "../src/index.ts";

describe("environment items", () => {
  test("name and notes round-trip", () => {
    expect(environmentItemName("myapp", "dev")).toBe("myapp/dev");
    const notes = environmentItemNotes("myapp", "dev");
    expect(notes.split("\n")[0]).toBe(ITEM_MARKER);
    expect(parseEnvironmentItem({ notes })).toEqual({ project: "myapp", environment: "dev" });
  });

  test.each([
    [null],
    ["just some notes"],
    ["envkit:v1\nproject=myapp"],
    ["envkit:v2\nproject=myapp\nenvironment=dev"],
  ])("ignores items that aren't envkit environments: %j", (notes) => {
    expect(parseEnvironmentItem({ notes })).toBeUndefined();
  });

  test("tolerates CRLF and edits in the web vault", () => {
    const notes =
      "envkit:v1\r\nproject= myapp \r\nenvironment=prod\r\n\r\nOwned by the platform team";
    expect(parseEnvironmentItem({ notes })).toEqual({ project: "myapp", environment: "prod" });
  });
});

describe("names", () => {
  test.each(["myapp", "my-app", "my_app.v2", "App1"])("accepts %s", (name) => {
    expect(validateProjectName(name)).toBe(name);
    expect(validateEnvironmentName(name)).toBe(name);
  });

  test.each(["", "my/app", "-app", "my app", ".hidden"])("rejects %j", (name) => {
    expect(() => validateProjectName(name)).toThrow("Invalid project name");
    expect(() => validateEnvironmentName(name)).toThrow("Invalid environment name");
  });
});

describe("canCreateCollections", () => {
  test.each([
    ["owner", true],
    ["admin", true],
    ["manager", false],
    ["user", false],
    ["custom", false],
  ] as const)("%s → %s", (role, expected) => {
    expect(canCreateCollections({ id: "o", name: "Acme", role })).toBe(expected);
  });
});
