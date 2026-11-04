import { EnvkitError } from "./errors.ts";
import { FieldType, type VaultItem } from "./vault/backend.ts";
import type { Env } from "./paths.ts";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

export interface ReadVariablesResult {
  /** Variables in field order. Values are literal: no `${...}` expansion. */
  variables: Map<string, string>;
  /** Fields that were skipped or overridden, for the user to fix. */
  warnings: string[];
}

/** Turns an environment item's custom fields into variables. */
export function readVariables(item: Pick<VaultItem, "fields">): ReadVariablesResult {
  const variables = new Map<string, string>();
  const warnings: string[] = [];
  for (const field of item.fields) {
    const name = field.name?.trim() ?? "";
    if (!isValidVariableName(name)) {
      warnings.push(`skipping field "${field.name}": not a valid variable name`);
      continue;
    }
    if (
      field.type !== FieldType.Text &&
      field.type !== FieldType.Hidden &&
      field.type !== FieldType.Boolean
    ) {
      warnings.push(`skipping field "${name}": linked fields have no value`);
      continue;
    }
    if (variables.has(name)) {
      warnings.push(`field "${name}" appears more than once; using the last one`);
      variables.delete(name);
    }
    variables.set(name, field.value ?? (field.type === FieldType.Boolean ? "false" : ""));
  }
  return { variables, warnings };
}

/** envkit's own secrets, never passed on to commands it runs. */
export const PRIVATE_ENV = ["ENVKIT_PASSWORD", "ENVKIT_SESSION"] as const;

/**
 * The environment for a child process: `base` (without envkit's secrets) plus
 * the vault's variables. Vault values win unless `override` is false.
 */
export function buildChildEnv(
  base: Env,
  variables: Map<string, string>,
  { override = true }: { override?: boolean } = {},
): Env {
  const env: Env = { ...base };
  for (const name of PRIVATE_ENV) delete env[name];
  for (const [name, value] of variables) {
    if (override || env[name] === undefined) env[name] = value;
  }
  return env;
}

export type OutputFormat = "dotenv" | "json" | "shell";
export const OUTPUT_FORMATS: OutputFormat[] = ["dotenv", "json", "shell"];

export function formatVariables(variables: Map<string, string>, format: OutputFormat): string {
  const entries = [...variables];
  switch (format) {
    case "json":
      return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    case "shell":
      return entries.map(([name, value]) => `export ${name}=${shellQuote(value)}\n`).join("");
    case "dotenv":
      return entries.map(([name, value]) => `${name}=${dotenvQuote(name, value)}\n`).join("");
  }
}

/** POSIX single quoting: safe for `eval`, nothing inside is expanded. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes a value for a .env file so dotenv (and loaders that follow it) read
 * it back unchanged. dotenv keeps single- and backtick-quoted text literally
 * (real newlines included) and only expands \n and \r inside double quotes,
 * with no other escapes. Values none of these can hold exactly are refused
 * rather than written subtly wrong.
 */
export function dotenvQuote(name: string, value: string): string {
  if (/^[A-Za-z0-9_\-.,:/@+%]*$/.test(value)) return value;
  // dotenv normalizes line endings, so a literal \r only survives as an escape.
  if (!value.includes("\r")) {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes("`")) return `\`${value}\``;
  }
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    return `"${value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;
  }
  throw new EnvkitError(`${name}'s value can't be written to a .env file exactly`, {
    hint: "It mixes quote characters with line breaks. Use `--format json` or `--format shell`, or `envkit run`.",
  });
}
