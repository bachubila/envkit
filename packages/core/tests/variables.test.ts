import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import { describe, expect, test } from "vite-plus/test";
import {
  buildChildEnv,
  dotenvQuote,
  FieldType,
  formatVariables,
  EnvkitError,
  readVariables,
  shellQuote,
  type VaultField,
} from "../src/index.ts";

const hidden = (name: string, value: string | null): VaultField => ({
  name,
  value,
  type: FieldType.Hidden,
});

describe("readVariables", () => {
  test("hidden, text and boolean fields become variables", () => {
    const { variables, warnings } = readVariables({
      fields: [
        hidden("API_KEY", "s3cret"),
        { name: "REGION", value: "eu-west-1", type: FieldType.Text },
        { name: "DEBUG", value: "true", type: FieldType.Boolean },
        hidden("EMPTY", null),
      ],
    });
    expect(Object.fromEntries(variables)).toEqual({
      API_KEY: "s3cret",
      REGION: "eu-west-1",
      DEBUG: "true",
      EMPTY: "",
    });
    expect(warnings).toEqual([]);
  });

  test("skips invalid names and linked fields, and warns", () => {
    const { variables, warnings } = readVariables({
      fields: [
        hidden("my key", "x"),
        hidden("1ST", "x"),
        { name: "USER", value: null, type: 3 as FieldType },
        hidden("OK", "y"),
      ],
    });
    expect([...variables.keys()]).toEqual(["OK"]);
    expect(warnings).toEqual([
      'skipping field "my key": not a valid variable name',
      'skipping field "1ST": not a valid variable name',
      'skipping field "USER": linked fields have no value',
    ]);
  });

  test("duplicate names: the last one wins, with a warning", () => {
    const { variables, warnings } = readVariables({
      fields: [hidden("A", "1"), hidden("B", "2"), hidden("A", "3")],
    });
    expect([...variables]).toEqual([
      ["B", "2"],
      ["A", "3"],
    ]);
    expect(warnings).toEqual(['field "A" appears more than once; using the last one']);
  });
});

describe("buildChildEnv", () => {
  const vault = new Map([
    ["API_KEY", "from-vault"],
    ["NEW", "new"],
  ]);

  test("vault values override the shell by default", () => {
    expect(buildChildEnv({ API_KEY: "from-shell", PATH: "/bin" }, vault)).toEqual({
      API_KEY: "from-vault",
      NEW: "new",
      PATH: "/bin",
    });
  });

  test("override: false keeps what the shell has", () => {
    expect(buildChildEnv({ API_KEY: "from-shell" }, vault, { override: false })).toEqual({
      API_KEY: "from-shell",
      NEW: "new",
    });
  });

  test("never passes envkit's own secrets on", () => {
    const env = buildChildEnv(
      { ENVKIT_PASSWORD: "master", ENVKIT_SESSION: "key", ENVKIT_HOME: "/h" },
      vault,
    );
    expect(env.ENVKIT_PASSWORD).toBeUndefined();
    expect(env.ENVKIT_SESSION).toBeUndefined();
    expect(env.ENVKIT_HOME).toBe("/h");
  });
});

// Values that tend to break naive .env writers.
const tricky = new Map([
  ["PLAIN", "abc-123_x.y:z/@+%"],
  ["SPACES", "hello world"],
  ["DOLLAR", "pa$$word ${HOME} $HOME"],
  ["HASH", "value # not a comment"],
  ["SINGLE", "it's"],
  ["DOUBLE", 'say "hi"'],
  ["BOTH", `it's "both"`],
  ["MULTILINE", "line1\nline2\n"],
  ["PEM", "-----BEGIN KEY-----\nabc\\n=\n-----END KEY-----"],
  ["BACKSLASH", "C:\\path\\to"],
  ["EQUALS", "a=b=c"],
  ["EMPTY", ""],
  ["UNICODE", "héllo ✓"],
  ["BACKTICK", "`whoami`"],
  ["CRLF", "windows\r\nline"],
]);

describe("formatVariables", () => {
  test("dotenv output parses back unchanged with the dotenv package", () => {
    const text = formatVariables(tricky, "dotenv");
    expect(parse(text)).toEqual(Object.fromEntries(tricky));
  });

  test("shell output evaluates back unchanged in sh", () => {
    const text = formatVariables(tricky, "shell");
    const script = `${text}\nnode -e 'console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(
      [...tricky.keys()],
    )}.map((k) => [k, process.env[k]]))))'`;
    const output = execFileSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(JSON.parse(output)).toEqual(Object.fromEntries(tricky));
  });

  test("json output", () => {
    expect(JSON.parse(formatVariables(tricky, "json"))).toEqual(Object.fromEntries(tricky));
  });

  test("keeps field order and ends with a newline", () => {
    const text = formatVariables(
      new Map([
        ["B", "1"],
        ["A", "2"],
      ]),
      "dotenv",
    );
    expect(text).toBe("B=1\nA=2\n");
  });

  test("empty", () => {
    expect(formatVariables(new Map(), "dotenv")).toBe("");
    expect(formatVariables(new Map(), "json")).toBe("{}\n");
  });
});

describe("quoting", () => {
  test.each([
    ["simple", "simple"],
    ["with space", "'with space'"],
    ["$HOME", "'$HOME'"],
    ["a\nb", "'a\nb'"],
    ["it's", "`it's`"],
    ["it's `x`", `"it's \`x\`"`],
    ["crlf\r\n", '"crlf\\r\\n"'],
  ])("dotenvQuote(%j) = %s", (value, expected) => {
    expect(dotenvQuote("X", value)).toBe(expected);
    expect(parse(`X=${expected}`).X).toBe(value);
  });

  test("refuses values a .env file can't hold exactly", () => {
    expect(() => dotenvQuote("KEY", `it's "quoted" \`and\`\nmultiline`)).toThrow(
      "KEY's value can't be written to a .env file exactly",
    );
    expect(() => formatVariables(new Map([["K", 'a"b\r']]), "dotenv")).toThrow(EnvkitError);
  });

  test("shellQuote escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("unsafe variables", () => {
  test("names that make programs run code, case-insensitively", async () => {
    const { isUnsafeVariable } = await import("../src/index.ts");
    for (const name of [
      "NODE_OPTIONS",
      "node_options",
      "PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "BASH_ENV",
      "PYTHONPATH",
      "JAVA_TOOL_OPTIONS",
      "GIT_SSH_COMMAND",
    ]) {
      expect(isUnsafeVariable(name), name).toBe(true);
    }
    for (const name of ["API_KEY", "DATABASE_URL", "NODE_ENV", "PORT", "HOLD_PATH", "PATHS"]) {
      expect(isUnsafeVariable(name), name).toBe(false);
    }
  });

  test("allowed names come from the flag and ENVKIT_ALLOW_VARIABLES only", async () => {
    const { allowedUnsafeVariables, withoutUnsafeVariables } = await import("../src/index.ts");
    const allowed = allowedUnsafeVariables(
      { ENVKIT_ALLOW_VARIABLES: " path , ld_preload" },
      "NODE_OPTIONS",
    );
    expect([...allowed].sort()).toEqual(["LD_PRELOAD", "NODE_OPTIONS", "PATH"]);
    const result = withoutUnsafeVariables(
      new Map([
        ["API_KEY", "k"],
        ["NODE_OPTIONS", "--require x"],
        ["DYLD_INSERT_LIBRARIES", "x"],
      ]),
      new Set(["NODE_OPTIONS"]),
    );
    expect([...result.variables.keys()]).toEqual(["API_KEY", "NODE_OPTIONS"]);
    expect(result.skipped).toEqual(["DYLD_INSERT_LIBRARIES"]);
  });
});
