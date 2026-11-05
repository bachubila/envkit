import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "@envkit/core";
import { createFakeBw, type FakeBw } from "@envkit/testkit";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
let bw: FakeBw;
let dir: string;

// The real binary in a child process, against a fake `bw`, so signals and
// exit codes go through actual processes.
beforeEach(async () => {
  bw = await createFakeBw();
  dir = await mkdtemp(join(tmpdir(), "envkit-signals-"));
  const ok = (data: unknown) => ({ stdout: { success: true, data } });
  await bw.respond(
    "status",
    ok({
      template: {
        status: "unlocked",
        serverUrl: "https://vault.test",
        userEmail: "a@example.test",
        lastSync: new Date().toISOString(),
      },
    }),
  );
  await bw.respond(
    "get item item-1",
    ok({
      id: "item-1",
      name: "myapp/dev",
      organizationId: "org-1",
      collectionIds: ["c1"],
      notes: "envkit:v1\nproject=myapp\nenvironment=dev",
      revisionDate: "2026-11-04T00:00:00.000Z",
      fields: [{ name: "GREETING", value: "hello from the vault", type: 1 }],
    }),
  );
  await writeFile(
    join(dir, CONFIG_FILE),
    JSON.stringify({
      version: 1,
      server: "https://vault.test",
      organizationId: "org-1",
      project: "myapp",
      defaultEnvironment: "dev",
      environments: { dev: { collectionId: "c1", itemId: "item-1" } },
    }),
  );
});

afterEach(async () => {
  await bw.cleanup();
  await rm(dir, { recursive: true, force: true });
});

function envkit(args: string[]) {
  const child = spawn(process.execPath, ["--conditions=source", bin, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      ENVKIT_HOME: join(dir, "home"),
      ENVKIT_BACKEND: "bw",
      ENVKIT_BW_PATH: bw.path,
      ENVKIT_SESSION: "test-session",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done, stdout: () => stdout };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("envkit run (real processes)", () => {
  test("the child sees the variables and inherits stdout", async () => {
    const { done } = envkit([
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.GREETING)",
    ]);
    const result = await done;
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("hello from the vault\n");
    expect(result.code).toBe(0);
  });

  test("forwards SIGTERM to the child and exits with its code", async () => {
    const ready = join(dir, "ready");
    const script = `
      process.on("SIGTERM", () => { console.log("child got SIGTERM"); process.exit(3); });
      require("fs").writeFileSync(${JSON.stringify(ready)}, "");
      setInterval(() => {}, 1000);
    `;
    const { child, done } = envkit(["run", "--", process.execPath, "-e", script]);
    await waitFor(() =>
      readFile(ready).then(
        () => true,
        () => false,
      ),
    );
    child.kill("SIGTERM");
    const result = await done;
    expect(result.stdout).toContain("child got SIGTERM");
    expect(result.code).toBe(3);
  });

  test("a child killed by a signal exits with 128 + signal number", async () => {
    const { done } = envkit([
      "run",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    expect((await done).code).toBe(128 + 9);
  });
});
