import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { EnvkitError } from "./errors.ts";

export const CONFIG_FILE = ".envkit.json";

const EnvironmentSchema = v.object({
  collectionId: v.pipe(v.string(), v.nonEmpty()),
  itemId: v.pipe(v.string(), v.nonEmpty()),
});

const ConfigSchema = v.pipe(
  v.object({
    version: v.literal(1),
    server: v.pipe(v.string(), v.url()),
    organizationId: v.pipe(v.string(), v.nonEmpty()),
    project: v.pipe(v.string(), v.nonEmpty()),
    defaultEnvironment: v.string(),
    environments: v.record(v.string(), EnvironmentSchema),
  }),
  v.check(
    (config) => Object.keys(config.environments).length > 0,
    "environments must not be empty",
  ),
  v.check(
    (config) => config.defaultEnvironment in config.environments,
    "defaultEnvironment must be one of environments",
  ),
);

/**
 * Contents of `.envkit.json`. It holds only IDs and names, never secret
 * values, so it is meant to be committed.
 */
export type EnvkitConfig = v.InferOutput<typeof ConfigSchema>;
export type EnvironmentRef = v.InferOutput<typeof EnvironmentSchema>;

export interface LoadedConfig {
  path: string;
  config: EnvkitConfig;
}

export function parseConfig(value: unknown, path = CONFIG_FILE): EnvkitConfig {
  const result = v.safeParse(ConfigSchema, value);
  if (result.success) return result.output;
  const issues = result.issues.map((issue) => {
    const key = v.getDotPath(issue);
    return key ? `${key}: ${issue.message}` : issue.message;
  });
  throw new EnvkitError(`Invalid ${path}`, { hint: issues.join("\n") });
}

/** Looks for `.envkit.json` in `cwd` and each parent directory. */
export async function findConfig(cwd: string): Promise<LoadedConfig | undefined> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, CONFIG_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (dirname(dir) === dir) return undefined;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new EnvkitError(`${path} is not valid JSON`, { hint: (error as Error).message });
    }
    return { path, config: parseConfig(json, path) };
  }
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const found = await findConfig(cwd);
  if (!found) {
    throw new EnvkitError(`No ${CONFIG_FILE} found in this directory or its parents`, {
      hint: "Run `envkit init` to set up a new project, or `envkit link <project>` to use an existing one.",
    });
  }
  return found;
}

export async function writeConfig(path: string, config: EnvkitConfig): Promise<void> {
  // Fixed key order and sorted environments keep diffs small.
  const environments = Object.fromEntries(
    Object.entries(config.environments)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ref]) => [name, { collectionId: ref.collectionId, itemId: ref.itemId }]),
  );
  const ordered: EnvkitConfig = {
    version: 1,
    server: config.server,
    organizationId: config.organizationId,
    project: config.project,
    defaultEnvironment: config.defaultEnvironment,
    environments,
  };
  await writeFile(path, `${JSON.stringify(parseConfig(ordered, path), null, 2)}\n`);
}

/** The named environment, or the default one. */
export function resolveEnvironment(
  config: EnvkitConfig,
  name?: string,
): EnvironmentRef & { name: string } {
  const environment = name ?? config.defaultEnvironment;
  const ref = config.environments[environment];
  if (!ref) {
    throw new EnvkitError(`Unknown environment "${environment}"`, {
      hint: `This project has: ${Object.keys(config.environments).sort().join(", ")}.`,
    });
  }
  return { name: environment, ...ref };
}
