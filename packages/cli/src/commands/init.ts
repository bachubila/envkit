import { basename, join } from "node:path";
import {
  CONFIG_FILE,
  EnvkitError,
  findConfig,
  validateEnvironmentName,
  validateProjectName,
  writeConfig,
  type EnvironmentRef,
} from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import {
  chooseOrganization,
  ensureCollection,
  ensureEnvironmentItem,
  parseList,
} from "../project.ts";
import { requireSession } from "../session.ts";

export const init = defineCommand({
  meta: {
    name: "init",
    description: `Set up a new project in this directory and write ${CONFIG_FILE}`,
  },
  args: {
    org: { type: "string", description: "Organization name or id" },
    project: { type: "string", description: "Project name (default: directory name)" },
    collection: { type: "string", description: "Collection to use (default: project name)" },
    env: {
      type: "string",
      description: "Comma-separated environments; the first is the default (default: dev)",
      valueHint: "dev,prod",
    },
    force: { type: "boolean", description: `Overwrite an existing ${CONFIG_FILE}` },
  },
  async run({ args }) {
    const context = useContext();
    const configPath = join(context.cwd, CONFIG_FILE);
    const existing = await findConfig(context.cwd).catch(() => undefined);
    if (existing?.path === configPath && !args.force) {
      throw new EnvkitError(
        `${CONFIG_FILE} already exists for project "${existing.config.project}"`,
        {
          hint: "Use `envkit env add <name>` to add environments, or --force to start over.",
        },
      );
    }

    const project = validateProjectName(
      args.project ??
        (context.interactive
          ? await context.prompt.text("Project name", { initialValue: basename(context.cwd) })
          : basename(context.cwd)),
    );
    const environments = (
      args.env !== undefined
        ? parseList(args.env)
        : context.interactive
          ? parseList(
              await context.prompt.text("Environments (comma-separated, first is the default)", {
                initialValue: "dev",
              }),
            )
          : ["dev"]
    ).map(validateEnvironmentName);
    if (environments.length === 0) throw new EnvkitError("Give at least one environment");

    const { session, status } = await requireSession(context);
    // `bw` reads a local copy of the vault; without a sync we could miss a
    // collection a teammate just created and make a duplicate.
    await context.backend().sync(session);
    const organization = await chooseOrganization(context, session, args.org);
    const { collection, created } = await ensureCollection(
      context,
      session,
      organization,
      args.collection ?? project,
    );
    context.output.stdout(
      `${created ? "Created" : "Using"} collection "${collection.name}" in ${organization.name}.`,
    );

    const refs: Record<string, EnvironmentRef> = {};
    for (const environment of environments) {
      const { item, created: itemCreated } = await ensureEnvironmentItem(context, session, {
        organizationId: organization.id,
        collectionId: collection.id,
        project,
        environment,
      });
      refs[environment] = { collectionId: collection.id, itemId: item.id };
      context.output.stdout(
        `${itemCreated ? "Created" : "Found"} environment "${environment}" (${item.name}).`,
      );
    }

    await writeConfig(configPath, {
      version: 1,
      server: status.serverUrl!,
      organizationId: organization.id,
      project,
      defaultEnvironment: environments[0]!,
      environments: refs,
    });
    context.output.stdout(`Wrote ${CONFIG_FILE}.`);
    context.output.stdout(
      `Commit it so your team can use the project. It contains IDs only, no secrets. Teammates need access to the "${collection.name}" collection.`,
    );
    if (existing && existing.path !== configPath) {
      context.output.stderr(`note: this shadows ${existing.path} for this directory and below.`);
    }
  },
});
