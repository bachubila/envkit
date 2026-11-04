import { join } from "node:path";
import {
  CONFIG_FILE,
  EnvkitError,
  findConfig,
  validateProjectName,
  writeConfig,
  type EnvironmentRef,
  type Organization,
  type VaultItem,
} from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { chooseOrganization, findEnvironmentItems } from "../project.ts";
import { requireSession } from "../session.ts";

export const link = defineCommand({
  meta: {
    name: "link",
    description: `Use an existing project in this directory and write ${CONFIG_FILE}`,
  },
  args: {
    project: { type: "positional", description: "Project name", required: true },
    org: { type: "string", description: "Organization name or id" },
    env: { type: "string", description: "Default environment (default: dev, if present)" },
    force: { type: "boolean", description: `Overwrite an existing ${CONFIG_FILE}` },
  },
  async run({ args }) {
    const context = useContext();
    const project = validateProjectName(args.project);
    const configPath = join(context.cwd, CONFIG_FILE);
    const existing = await findConfig(context.cwd).catch(() => undefined);
    if (existing?.path === configPath && !args.force) {
      throw new EnvkitError(
        `${CONFIG_FILE} already exists for project "${existing.config.project}"`,
        {
          hint: "Use --force to replace it.",
        },
      );
    }

    const { session, status } = await requireSession(context);
    const backend = context.backend();
    // `bw` reads a local copy of the vault; pick up access granted since the last sync.
    await backend.sync(session);
    const organizations = args.org
      ? [await chooseOrganization(context, session, args.org)]
      : await backend.listOrganizations(session);

    const matches: { organization: Organization; items: Map<string, VaultItem> }[] = [];
    for (const organization of organizations) {
      const items = await findEnvironmentItems(
        context,
        session,
        { organizationId: organization.id },
        project,
      );
      if (items.size > 0) matches.push({ organization, items });
    }
    if (matches.length === 0) {
      throw new EnvkitError(`No envkit project "${project}" in your vault`, {
        hint: "Check the name and that you have access to its collection, or run `envkit init` to create it.",
      });
    }
    if (matches.length > 1) {
      throw new EnvkitError(`Project "${project}" exists in several organizations`, {
        hint: `Pick one with --org: ${matches.map((match) => match.organization.name).join(", ")}.`,
      });
    }

    const [{ organization, items }] = matches as [(typeof matches)[number]];
    const environments: Record<string, EnvironmentRef> = {};
    for (const [environment, item] of items) {
      const collectionId = item.collectionIds[0];
      if (collectionId) environments[environment] = { collectionId, itemId: item.id };
    }
    const names = Object.keys(environments).sort();
    const defaultEnvironment = args.env ?? (names.includes("dev") ? "dev" : names[0]!);
    if (!(defaultEnvironment in environments)) {
      throw new EnvkitError(`Project "${project}" has no environment "${defaultEnvironment}"`, {
        hint: `It has: ${names.join(", ")}.`,
      });
    }

    await writeConfig(configPath, {
      version: 1,
      server: status.serverUrl!,
      organizationId: organization.id,
      project,
      defaultEnvironment,
      environments,
    });
    context.output.stdout(
      `Linked "${project}" from ${organization.name}: ${names
        .map((name) => (name === defaultEnvironment ? `${name} (default)` : name))
        .join(", ")}.`,
    );
    context.output.stdout(`Wrote ${CONFIG_FILE}.`);
  },
});
