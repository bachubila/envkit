import { describe, expect, test } from "vite-plus/test";
import {
  applyVariableChanges,
  diffVariables,
  FieldType,
  formatVariables,
  parseDotenv,
  type VaultField,
} from "../src/index.ts";

const hidden = (name: string, value: string): VaultField => ({
  name,
  value,
  type: FieldType.Hidden,
});

describe("applyVariableChanges", () => {
  const fields: VaultField[] = [
    hidden("A", "1"),
    { name: "REGION", value: "eu", type: FieldType.Text },
    hidden("bad name", "kept"),
    { name: "LINKED", value: null, type: 3 as FieldType },
    hidden("B", "2"),
  ];

  test("updates in place, appends new ones as hidden, keeps fields envkit doesn't manage", () => {
    const result = applyVariableChanges(fields, {
      set: new Map([
        ["B", "two"],
        ["REGION", "us"],
        ["NEW", "n"],
      ]),
    });
    expect(result).toEqual([
      hidden("A", "1"),
      { name: "REGION", value: "us", type: FieldType.Text },
      hidden("bad name", "kept"),
      { name: "LINKED", value: null, type: 3 },
      hidden("B", "two"),
      hidden("NEW", "n"),
    ]);
  });

  test("unset removes every field with that name", () => {
    const result = applyVariableChanges([hidden("A", "1"), hidden("B", "2"), hidden("A", "3")], {
      unset: ["A"],
    });
    expect(result).toEqual([hidden("B", "2")]);
  });

  test("set collapses duplicates into one field at the first position", () => {
    const result = applyVariableChanges([hidden("A", "1"), hidden("B", "2"), hidden("A", "3")], {
      set: new Map([["A", "new"]]),
    });
    expect(result).toEqual([hidden("A", "new"), hidden("B", "2")]);
  });

  test("boolean fields become hidden when set", () => {
    const result = applyVariableChanges(
      [{ name: "DEBUG", value: "true", type: FieldType.Boolean }],
      {
        set: new Map([["DEBUG", "verbose"]]),
      },
    );
    expect(result).toEqual([hidden("DEBUG", "verbose")]);
  });
});

describe("diffVariables", () => {
  test("added, changed, removed and unchanged, sorted", () => {
    const before = new Map([
      ["KEEP", "1"],
      ["CHANGE", "old"],
      ["GONE", "x"],
    ]);
    const after = new Map([
      ["ZNEW", "z"],
      ["KEEP", "1"],
      ["CHANGE", "new"],
      ["ANEW", "a"],
    ]);
    expect(diffVariables(before, after)).toEqual({
      added: ["ANEW", "ZNEW"],
      changed: ["CHANGE"],
      removed: ["GONE"],
      unchanged: ["KEEP"],
    });
  });
});

describe("parseDotenv", () => {
  test("reads what pull writes", () => {
    const variables = new Map([
      ["A", "plain"],
      ["B", 'it\'s "quoted"'],
      ["C", "multi\nline"],
      ["D", "$NOT_EXPANDED"],
    ]);
    expect(parseDotenv(formatVariables(variables, "dotenv")).variables).toEqual(variables);
  });

  test("comments, export prefixes and blank lines", () => {
    const { variables, warnings } = parseDotenv(
      "# comment\n\nexport A=1\nB=2 # trailing comment\n",
    );
    expect(Object.fromEntries(variables)).toEqual({ A: "1", B: "2" });
    expect(warnings).toEqual([]);
  });

  test("reports names envkit can't use", () => {
    const { variables, warnings } = parseDotenv("OK=1\nmy.key=2\n");
    expect([...variables.keys()]).toEqual(["OK"]);
    expect(warnings).toEqual(['skipping "my.key": not a valid variable name']);
  });
});
