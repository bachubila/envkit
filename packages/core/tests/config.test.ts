import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  CONFIG_FILE,
  EnvkitError,
  findConfig,
  loadConfig,
  parseConfig,
  resolveEnvironment,
  writeConfig,
  type EnvkitConfig,
} from "../src/index.ts";

const config: EnvkitConfig = {
  version: 1,
  server: "https://vault.example.test",
  organizationId: "org-1",
  project: "myapp",
  defaultEnvironment: "dev",
  environments: {
    prod: { collectionId: "col-prod", itemId: "item-prod" },
    dev: { collectionId: "col-1", itemId: "item-dev" },
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "envkit-config-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("parseConfig", () => {
  test("accepts a valid config", () => {
    expect(parseConfig(structuredClone(config))).toEqual(config);
  });

  test.each([
    [{ ...config, version: 2 }, "version"],
    [{ ...config, server: "not a url" }, "server"],
    [{ ...config, environments: {} }, "environments must not be empty"],
    [
      { ...config, defaultEnvironment: "staging" },
      "defaultEnvironment must be one of environments",
    ],
    [{ ...config, environments: { dev: { collectionId: "c" } } }, "environments.dev.itemId"],
    [{ ...config, organizationId: undefined }, "organizationId"],
  ])("rejects %j", (value, problem) => {
    let error: unknown;
    try {
      parseConfig(value, "/repo/.envkit.json");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvkitError);
    expect((error as EnvkitError).message).toBe("Invalid /repo/.envkit.json");
    expect((error as EnvkitError).hint).toContain(problem);
  });
});

describe("findConfig / loadConfig", () => {
  test("finds the config in a parent directory", async () => {
    await writeConfig(join(dir, CONFIG_FILE), config);
    const nested = join(dir, "packages", "api", "src");
    await mkdir(nested, { recursive: true });
    const found = await findConfig(nested);
    expect(found?.path).toBe(join(dir, CONFIG_FILE));
    expect(found?.config.project).toBe("myapp");
  });

  test("the nearest config wins", async () => {
    await writeConfig(join(dir, CONFIG_FILE), config);
    const sub = join(dir, "sub");
    await mkdir(sub);
    await writeConfig(join(sub, CONFIG_FILE), { ...config, project: "other" });
    expect((await findConfig(sub))?.config.project).toBe("other");
  });

  test("returns undefined when there is none", async () => {
    // tmpdir() itself has no .envkit.json (and neither should any parent).
    expect(await findConfig(dir)).toBeUndefined();
  });

  test("loadConfig explains how to create one", async () => {
    await expect(loadConfig(dir)).rejects.toMatchObject({
      message: `No ${CONFIG_FILE} found in this directory or its parents`,
      hint: expect.stringContaining("envkit init"),
    });
  });

  test("broken JSON is reported with the file path", async () => {
    await writeFile(join(dir, CONFIG_FILE), "{ nope");
    await expect(findConfig(dir)).rejects.toMatchObject({
      message: `${join(dir, CONFIG_FILE)} is not valid JSON`,
    });
  });
});

describe("writeConfig", () => {
  test("writes stable, sorted, pretty JSON", async () => {
    const path = join(dir, CONFIG_FILE);
    await writeConfig(path, config);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "server",
      "organizationId",
      "project",
      "defaultEnvironment",
      "environments",
    ]);
    expect(Object.keys(JSON.parse(text).environments)).toEqual(["dev", "prod"]);
  });

  test("refuses to write an invalid config", async () => {
    await expect(
      writeConfig(join(dir, CONFIG_FILE), { ...config, defaultEnvironment: "nope" }),
    ).rejects.toBeInstanceOf(EnvkitError);
  });
});

describe("resolveEnvironment", () => {
  test("defaults to defaultEnvironment", () => {
    expect(resolveEnvironment(config)).toEqual({
      name: "dev",
      collectionId: "col-1",
      itemId: "item-dev",
    });
  });

  test("named environment", () => {
    expect(resolveEnvironment(config, "prod").itemId).toBe("item-prod");
  });

  test("unknown environment lists the known ones", () => {
    expect(() => resolveEnvironment(config, "qa")).toThrow(
      expect.objectContaining({
        message: 'Unknown environment "qa"',
        hint: "This project has: dev, prod.",
      }),
    );
  });
});
