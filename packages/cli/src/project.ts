import {
  canCreateCollections,
  EnvkitError,
  environmentItemName,
  environmentItemNotes,
  parseEnvironmentItem,
  type Collection,
  type EnvkitConfig,
  type Organization,
  type VaultItem,
  type VaultStatus,
} from "@envkit/core";
import type { CliContext } from "./context.ts";

/**
 * The organization `requested` names (by id or name), the only one the user
 * has, or one the user picks.
 */
export async function chooseOrganization(
  context: CliContext,
  session: string,
  requested: string | undefined,
): Promise<Organization> {
  const organizations = await context.backend().listOrganizations(session);
  if (organizations.length === 0) {
    throw new EnvkitError("You are not a member of any organization", {
      hint: "envkit shares variables through organization collections. Create an organization in the web vault, or ask to be invited to one.",
    });
  }
  if (requested) {
    const wanted = requested.toLowerCase();
    const match = organizations.find(
      (org) => org.id === requested || org.name.toLowerCase() === wanted,
    );
    if (!match) {
      throw new EnvkitError(`No organization "${requested}"`, {
        hint: `You are a member of: ${organizations.map((org) => org.name).join(", ")}.`,
      });
    }
    return match;
  }
  if (organizations.length === 1) return organizations[0]!;
  if (!context.interactive) {
    throw new EnvkitError("You are a member of several organizations", {
      hint: `Pick one with --org: ${organizations.map((org) => org.name).join(", ")}.`,
    });
  }
  return context.prompt.select(
    "Organization",
    organizations.map((org) => ({ value: org, label: org.name, hint: org.role })),
  );
}

/** The collection named `name`, created when missing and the user is allowed to. */
export async function ensureCollection(
  context: CliContext,
  session: string,
  organization: Organization,
  name: string,
): Promise<{ collection: Collection; created: boolean }> {
  const backend = context.backend();
  const existing = (await backend.listCollections(session, organization.id)).find(
    (collection) => collection.name === name,
  );
  if (existing) return { collection: existing, created: false };
  if (!canCreateCollections(organization)) {
    throw new EnvkitError(`Collection "${name}" doesn't exist in ${organization.name}`, {
      hint: `Only organization owners and admins can create collections. Ask one to create "${name}" and give you access, then run this again.`,
    });
  }
  return {
    collection: await backend.createCollection(session, organization.id, name),
    created: true,
  };
}

/** envkit items in the collection, keyed by environment, for `project`. */
export async function findEnvironmentItems(
  context: CliContext,
  session: string,
  filter: { organizationId: string; collectionId?: string },
  project: string,
): Promise<Map<string, VaultItem>> {
  const items = await context.backend().listItems(session, { ...filter, search: `${project}/` });
  const found = new Map<string, VaultItem>();
  for (const item of items) {
    const meta = parseEnvironmentItem(item);
    if (meta?.project === project && !found.has(meta.environment)) {
      found.set(meta.environment, item);
    }
  }
  return found;
}

/** Reuses the environment's item in the collection, or creates an empty one. */
export async function ensureEnvironmentItem(
  context: CliContext,
  session: string,
  options: { organizationId: string; collectionId: string; project: string; environment: string },
): Promise<{ item: VaultItem; created: boolean }> {
  const { organizationId, collectionId, project, environment } = options;
  const existing = (
    await findEnvironmentItems(context, session, { organizationId, collectionId }, project)
  ).get(environment);
  if (existing) return { item: existing, created: false };
  const item = await context.backend().createItem(session, {
    organizationId,
    collectionIds: [collectionId],
    name: environmentItemName(project, environment),
    notes: environmentItemNotes(project, environment),
    fields: [],
  });
  return { item, created: true };
}

/** Warns (without failing) when the project lives on a different server than the login. */
export function warnOnServerMismatch(
  context: CliContext,
  config: EnvkitConfig,
  status: VaultStatus,
): void {
  if (status.serverUrl && config.server !== status.serverUrl) {
    context.output.stderr(
      `warning: this project uses ${config.server}, but you are logged in to ${status.serverUrl}.`,
    );
    context.output.stderr(
      `Run \`envkit logout\`, then \`envkit login --server ${config.server}\`.`,
    );
  }
}

/** Parses a comma-separated list such as `dev,prod`, dropping blanks and duplicates. */
export function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}
