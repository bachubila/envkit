import {
  VaultError,
  CONFIG_FILE,
  EnvkitError,
  loadConfig,
  validateEnvironmentName,
  writeConfig,
  type Organization,
} from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { ensureCollection, ensureEnvironmentItem, warnOnServerMismatch } from "../project.ts";
import { requireSession } from "../session.ts";

const list = defineCommand({
  meta: {
    name: "list",
    description: "List the project's environments and check you can open each one",
  },
  async run() {
    const context = useContext();
    const { config } = await loadConfig(context.cwd);
    const { session, status } = await requireSession(context);
    warnOnServerMismatch(context, config, status);
    const backend = context.backend();
    await backend.sync(session);

    const names = Object.keys(config.environments).sort();
    const width = Math.max(...names.map((name) => name.length));
    let unreachable = 0;
    for (const name of names) {
      const ref = config.environments[name]!;
      let detail: string;
      try {
        const item = await backend.getItem(session, ref.itemId);
        const count = item.fields.length;
        detail = `${count} variable${count === 1 ? "" : "s"}`;
      } catch (error) {
        if (!(error instanceof VaultError)) throw error;
        unreachable++;
        detail = `not accessible (${error.message})`;
      }
      const marker = name === config.defaultEnvironment ? " (default)" : "";
      context.output.stdout(`${name.padEnd(width)}  ${detail}${marker}`);
    }
    if (unreachable > 0) {
      throw new EnvkitError(
        `${unreachable} environment${unreachable === 1 ? " is" : "s are"} not accessible`,
        {
          hint: `Ask an organization admin for access to the project's collection, or check that ${CONFIG_FILE} is up to date.`,
        },
      );
    }
  },
});

const add = defineCommand({
  meta: {
    name: "add",
    description: "Add an environment to the project",
  },
  args: {
    name: { type: "positional", description: "Environment name, e.g. staging", required: true },
    collection: {
      type: "string",
      description:
        "Put it in this collection instead of the default environment's (e.g. a restricted one for prod)",
    },
    default: { type: "boolean", description: "Make it the default environment" },
  },
  async run({ args }) {
    const context = useContext();
    const { path, config } = await loadConfig(context.cwd);
    const environment = validateEnvironmentName(args.name);
    if (config.environments[environment]) {
      throw new EnvkitError(`Environment "${environment}" already exists`);
    }
    const { session, status } = await requireSession(context);
    warnOnServerMismatch(context, config, status);
    const backend = context.backend();
    await backend.sync(session);

    let collectionId = config.environments[config.defaultEnvironment]!.collectionId;
    if (args.collection) {
      const organization = await findProjectOrganization(context, session, config.organizationId);
      const { collection, created } = await ensureCollection(
        context,
        session,
        organization,
        args.collection,
      );
      collectionId = collection.id;
      if (created) context.output.stdout(`Created collection "${collection.name}".`);
    }

    const { item, created } = await ensureEnvironmentItem(context, session, {
      organizationId: config.organizationId,
      collectionId,
      project: config.project,
      environment,
    });
    config.environments[environment] = { collectionId, itemId: item.id };
    if (args.default) config.defaultEnvironment = environment;
    await writeConfig(path, config);
    context.output.stdout(
      `${created ? "Added" : "Linked existing"} environment "${environment}" (${item.name}).`,
    );
  },
});

const remove = defineCommand({
  meta: {
    name: "remove",
    description: `Remove an environment from ${CONFIG_FILE}`,
  },
  args: {
    name: { type: "positional", description: "Environment name", required: true },
    delete: {
      type: "boolean",
      description: "Also move its vault item to the trash (restorable from the web vault)",
    },
  },
  async run({ args }) {
    const context = useContext();
    const { path, config } = await loadConfig(context.cwd);
    const environment = args.name;
    const ref = config.environments[environment];
    if (!ref) {
      throw new EnvkitError(`Unknown environment "${environment}"`, {
        hint: `This project has: ${Object.keys(config.environments).sort().join(", ")}.`,
      });
    }
    const remaining = Object.keys(config.environments)
      .filter((name) => name !== environment)
      .sort();
    if (remaining.length === 0) {
      throw new EnvkitError(`"${environment}" is the project's only environment`, {
        hint: `Add another one first, or delete ${CONFIG_FILE} to stop using envkit here.`,
      });
    }

    if (args.delete) {
      const { session, status } = await requireSession(context);
      warnOnServerMismatch(context, config, status);
      await context.backend().deleteItem(session, ref.itemId);
      context.output.stdout(`Moved the "${environment}" item to the vault's trash.`);
    }

    delete config.environments[environment];
    if (config.defaultEnvironment === environment) {
      config.defaultEnvironment = remaining[0]!;
      context.output.stdout(`"${remaining[0]}" is now the default environment.`);
    }
    await writeConfig(path, config);
    context.output.stdout(`Removed environment "${environment}" from ${CONFIG_FILE}.`);
  },
});

export const env = defineCommand({
  meta: {
    name: "env",
    description: "Manage the project's environments",
  },
  subCommands: { list, add, remove },
});

async function findProjectOrganization(
  context: ReturnType<typeof useContext>,
  session: string,
  organizationId: string,
): Promise<Organization> {
  const organizations = await context.backend().listOrganizations(session);
  const organization = organizations.find((org) => org.id === organizationId);
  if (!organization) {
    throw new EnvkitError("You are not a member of this project's organization", {
      hint: "Ask an organization admin to invite you.",
    });
  }
  return organization;
}
