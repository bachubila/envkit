import { EnvkitError } from "./errors.ts";
import type { VaultItem } from "./vault/backend.ts";

/** First line of the notes of every item envkit manages. */
export const ITEM_MARKER = "envkit:v1";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateProjectName(name: string): string {
  if (!NAME.test(name)) {
    throw new EnvkitError(`Invalid project name "${name}"`, {
      hint: "Use letters, digits, `.`, `_` and `-`, starting with a letter or digit.",
    });
  }
  return name;
}

export function validateEnvironmentName(name: string): string {
  if (!NAME.test(name)) {
    throw new EnvkitError(`Invalid environment name "${name}"`, {
      hint: "Use letters, digits, `.`, `_` and `-`, e.g. dev, staging, prod.",
    });
  }
  return name;
}

/** Vault item name for one environment, e.g. `myapp/dev`. */
export function environmentItemName(project: string, environment: string): string {
  return `${project}/${environment}`;
}

/** Notes for a new environment item: the marker plus metadata `link` uses to find it. */
export function environmentItemNotes(project: string, environment: string): string {
  return [
    ITEM_MARKER,
    `project=${project}`,
    `environment=${environment}`,
    "",
    "Managed by envkit: each hidden custom field is one environment variable.",
  ].join("\n");
}

/** The project and environment an envkit item belongs to, or undefined for other items. */
export function parseEnvironmentItem(
  item: Pick<VaultItem, "notes">,
): { project: string; environment: string } | undefined {
  const lines = (item.notes ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== ITEM_MARKER) return undefined;
  const meta = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (match) meta.set(match[1]!, match[2]!.trim());
  }
  const project = meta.get("project");
  const environment = meta.get("environment");
  return project && environment ? { project, environment } : undefined;
}

/**
 * Checks that the item `.envkit.json` points at really is this project's
 * environment: in the project's organization and the environment's
 * collection, with matching envkit notes. `.envkit.json` is committed, so
 * anyone who can push could otherwise point a teammate's reads (and writes)
 * at an item of their choosing.
 */
export function verifyEnvironmentItem(
  item: Pick<VaultItem, "organizationId" | "collectionIds" | "notes">,
  expected: { organizationId: string; collectionId: string; project: string; environment: string },
): void {
  const meta = parseEnvironmentItem(item);
  if (
    item.organizationId === expected.organizationId &&
    item.collectionIds.includes(expected.collectionId) &&
    meta?.project === expected.project &&
    meta.environment === expected.environment
  ) {
    return;
  }
  throw new EnvkitError(
    `.envkit.json points "${expected.environment}" at a vault item that isn't ${environmentItemName(expected.project, expected.environment)}`,
    {
      hint:
        "Check who changed .envkit.json (`git log -p .envkit.json`). " +
        `To restore it from the vault, run \`envkit link ${expected.project} --force\`.`,
    },
  );
}
