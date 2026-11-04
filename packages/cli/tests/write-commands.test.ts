import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FieldType, type VaultField } from "@envkit/core";
import { describe, expect, test } from "vite-plus/test";
import { ALICE, harness, SERVER } from "./helpers.ts";

const hidden = (name: string, value: string): VaultField => ({
  name,
  value,
  type: FieldType.Hidden,
});

async function project(options: { interactive?: boolean; answers?: string[] } = {}) {
  const h = harness({ env: { ENVKIT_PASSWORD: ALICE.password }, ...options });
  h.vault.seedLogin(SERVER, ALICE.email);
  h.vault.organizations = [{ id: "org-1", name: "Acme", role: "owner" }];
  const init = await h.envkit("init", "--project", "myapp", "--env", "dev,prod");
  expect(init.code, init.stderr).toBe(0);
  h.vault.editElsewhere("item-1", (item) => {
    item.fields = [hidden("API_KEY", "dev-key"), hidden("DB_URL", "postgres://dev")];
  });
  h.vault.editElsewhere("item-2", (item) => {
    item.fields = [hidden("API_KEY", "prod-key"), hidden("SENTRY_DSN", "https://sentry")];
  });
  h.vault.calls.length = 0;
  const fields = (id = "item-1") => h.vault.items.get(id)!.fields;
  const pulled = async (env = "dev") =>
    JSON.parse((await h.envkit("pull", "--format", "json", "-e", env)).stdout);
  return { ...h, fields, pulled };
}

describe("envkit set", () => {
  test("sets several variables at once", async () => {
    const { envkit, pulled } = await project();
    const result = await envkit("set", "API_KEY=new-key", "PORT=3000");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe('Added PORT; updated API_KEY in "dev".');
    expect(await pulled()).toEqual({
      API_KEY: "new-key",
      DB_URL: "postgres://dev",
      PORT: "3000",
    });
  });

  test("values may contain = and be empty", async () => {
    const { envkit, pulled } = await project();
    await envkit("set", "URL=https://x.test/?a=b&c=d", "EMPTY=");
    expect(await pulled()).toMatchObject({ URL: "https://x.test/?a=b&c=d", EMPTY: "" });
  });

  test("-e targets another environment", async () => {
    const { envkit, pulled } = await project();
    await envkit("set", "-e", "prod", "API_KEY=rotated");
    expect((await pulled("prod")).API_KEY).toBe("rotated");
    expect((await pulled("dev")).API_KEY).toBe("dev-key");
  });

  test("a bare KEY reads the value from stdin, without the trailing newline", async () => {
    const { envkit, pipe, pulled } = await project();
    pipe("-----BEGIN KEY-----\nabc\n-----END KEY-----\n");
    expect((await envkit("set", "TLS_KEY")).code).toBe(0);
    expect((await pulled()).TLS_KEY).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  test("a bare KEY prompts (hidden) in a terminal", async () => {
    const { envkit, prompts, pulled } = await project({ interactive: true, answers: ["typed"] });
    expect((await envkit("set", "SECRET")).code).toBe(0);
    expect(prompts.asked).toEqual(["Value for SECRET"]);
    expect((await pulled()).SECRET).toBe("typed");
  });

  test("a bare KEY without stdin or terminal explains the options", async () => {
    const { envkit } = await project();
    const result = await envkit("set", "SECRET");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No value for SECRET");
  });

  test("rejects invalid names and several bare keys before touching the vault", async () => {
    const { envkit, vault } = await project();
    expect((await envkit("set", "my-key=1")).stderr).toContain('Invalid variable name "my-key"');
    expect((await envkit("set", "A", "B")).stderr).toContain(
      "Only one variable can read its value from stdin",
    );
    expect((await envkit("set")).stderr).toContain("Give at least one KEY=value");
    expect(vault.calls).toEqual([]);
  });

  test("setting the same value doesn't write", async () => {
    const { envkit, vault } = await project();
    const result = await envkit("set", "API_KEY=dev-key");
    expect(result.stdout).toBe('Nothing to change in "dev".');
    expect(vault.calls.some((call) => call.startsWith("updateItem"))).toBe(false);
  });

  test("always syncs before writing, even when the local copy is fresh", async () => {
    const { envkit, vault } = await project();
    vault.lastSync = new Date();
    await envkit("set", "X=1");
    expect(vault.calls.indexOf("sync")).toBeLessThan(vault.calls.indexOf("updateItem myapp/dev"));
  });

  test("keeps fields envkit doesn't manage", async () => {
    const { envkit, vault, fields } = await project();
    vault.editElsewhere("item-1", (item) => item.fields.push(hidden("not valid", "keep me")));
    await envkit("set", "X=1");
    expect(fields().map((field) => field.name)).toEqual(["API_KEY", "DB_URL", "not valid", "X"]);
  });
});

describe("envkit unset", () => {
  test("removes variables and mentions ones that weren't set", async () => {
    const { envkit, pulled } = await project();
    const result = await envkit("unset", "DB_URL", "NOPE");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Removed DB_URL in "dev".');
    expect(result.stderr).toBe('NOPE is not set in "dev".');
    expect(await pulled()).toEqual({ API_KEY: "dev-key" });
  });

  test("nothing to remove", async () => {
    const { envkit } = await project();
    expect((await envkit("unset", "NOPE")).stdout).toBe('Nothing to change in "dev".');
    expect((await envkit("unset")).stderr).toContain("Name the variables to remove");
  });
});

describe("conflicts", () => {
  test("a write based on an outdated read is refused, and a retry applies on top", async () => {
    const { envkit, vault, pulled } = await project();
    // Someone saves between envkit's read and its write.
    const original = vault.getItem.bind(vault);
    let once = true;
    vault.getItem = async (session, id) => {
      const item = await original(session, id);
      if (once) {
        once = false;
        vault.editElsewhere(id, (stored) => stored.fields.push(hidden("THEIRS", "t")));
      }
      return item;
    };
    const result = await envkit("set", "MINE=m");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("This environment changed since envkit read it");
    expect(result.stderr).toContain("Run the command again");

    expect((await envkit("set", "MINE=m")).code).toBe(0);
    expect(await pulled()).toMatchObject({ THEIRS: "t", MINE: "m" });
  });
});

describe("envkit push", () => {
  test("shows a keys-only preview and applies with --yes", async () => {
    const { envkit, cwd, pulled } = await project();
    writeFileSync(join(cwd, ".env"), "API_KEY=dev-key\nDB_URL=postgres://changed\nNEW=1\n");
    const result = await envkit("push", "--yes");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        'Changes to "dev":',
        "  + NEW",
        "  ~ DB_URL",
        "  (1 unchanged)",
        'Added NEW; updated DB_URL in "dev".',
      ].join("\n"),
    );
    expect(result.stdout).not.toContain("postgres://changed");
    expect(await pulled()).toEqual({ API_KEY: "dev-key", DB_URL: "postgres://changed", NEW: "1" });
  });

  test("asks for confirmation in a terminal; no means no", async () => {
    const declined = await project({ interactive: true, answers: ["no"] });
    writeFileSync(join(declined.cwd, ".env"), "NEW=1\n");
    const result = await declined.envkit("push");
    expect(result.stdout).toContain("Nothing changed.");
    expect(declined.prompts.asked).toEqual(['Apply these changes to "dev"?']);
    expect((await declined.pulled()).NEW).toBeUndefined();

    const accepted = await project({ interactive: true, answers: ["yes"] });
    writeFileSync(join(accepted.cwd, ".env"), "NEW=1\n");
    await accepted.envkit("push");
    expect((await accepted.pulled()).NEW).toBe("1");
  });

  test("without a terminal it needs --yes", async () => {
    const { envkit, cwd, vault } = await project();
    writeFileSync(join(cwd, ".env"), "NEW=1\n");
    const result = await envkit("push");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Pass --yes");
    expect(vault.calls.some((call) => call.startsWith("updateItem"))).toBe(false);
  });

  test("--prune removes what the file doesn't have; without it nothing is removed", async () => {
    const { envkit, cwd, pulled } = await project();
    writeFileSync(join(cwd, "prod.env"), "API_KEY=prod-key\n");
    await envkit("push", "--from", "prod.env", "-e", "prod", "--yes");
    expect(Object.keys(await pulled("prod"))).toEqual(["API_KEY", "SENTRY_DSN"]);

    const result = await envkit("push", "--from", "prod.env", "-e", "prod", "--prune", "--yes");
    expect(result.stdout).toContain("  - SENTRY_DSN");
    expect(await pulled("prod")).toEqual({ API_KEY: "prod-key" });
  });

  test("--from - reads stdin; no changes means no write", async () => {
    const { envkit, pipe, vault } = await project();
    pipe("API_KEY=dev-key\n");
    expect((await envkit("push", "--from", "-", "--yes")).stdout).toBe(
      'Nothing to change in "dev".',
    );
    expect(vault.calls.some((call) => call.startsWith("updateItem"))).toBe(false);
  });

  test("round-trips with pull", async () => {
    const { envkit, vault, pulled } = await project();
    vault.editElsewhere("item-1", (item) => {
      item.fields = [hidden("PEM", "line1\nline2"), hidden("QUOTES", `it's "x"`)];
    });
    await envkit("pull", "--out", ".env");
    await envkit("set", "PEM=other");
    await envkit("push", "--yes");
    expect(await pulled()).toEqual({ PEM: "line1\nline2", QUOTES: `it's "x"` });
  });

  test("missing file", async () => {
    const { envkit } = await project();
    expect((await envkit("push", "--yes")).stderr).toContain(".env not found");
  });
});

describe("envkit diff", () => {
  test("compares names only", async () => {
    const { envkit } = await project();
    const result = await envkit("diff", "dev", "prod");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      [
        "dev → prod",
        "  only in dev:   DB_URL",
        "  only in prod:  SENTRY_DSN",
        "  different:     API_KEY",
        "  same:          0 variables",
      ].join("\n"),
    );
    expect(result.stdout).not.toContain("prod-key");
  });

  test("one name compares the default environment with it", async () => {
    const { envkit } = await project();
    expect((await envkit("diff", "prod")).stdout.split("\n")[0]).toBe("dev → prod");
  });

  test("--check fails only when a name is missing on either side", async () => {
    const { envkit, vault } = await project();
    expect((await envkit("diff", "dev", "prod", "--check")).code).toBe(1);
    vault.editElsewhere("item-2", (item) => {
      item.fields = [hidden("API_KEY", "other"), hidden("DB_URL", "postgres://prod")];
    });
    expect((await envkit("diff", "dev", "prod", "--check")).code).toBe(0);
  });

  test("argument errors", async () => {
    const { envkit } = await project();
    expect((await envkit("diff")).stderr).toContain("Name one or two environments");
    expect((await envkit("diff", "dev", "dev")).stderr).toContain("Pick two different");
    expect((await envkit("diff", "dev", "qa")).stderr).toContain('Unknown environment "qa"');
  });
});
