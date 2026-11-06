import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { NativeBackend } from "../src/index.ts";
import type { HttpRequest } from "../src/vault/native/http.ts";

const sent: HttpRequest[] = [];

vi.mock("../src/vault/native/http.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/vault/native/http.ts")>();
  return {
    ...original,
    send: async (req: HttpRequest) => {
      sent.push(req);
      throw new original.HttpError(400, "stop here", undefined);
    },
  };
});

let home: string | undefined;
afterEach(async () => {
  sent.length = 0;
  if (home) await rm(home, { recursive: true, force: true });
});

// Bitwarden's own servers reject requests without these:
// "No client version header found, required to prevent encryption errors."
test("every request identifies the client to the server", async () => {
  home = await mkdtemp(join(tmpdir(), "envkit-headers-"));
  const backend = NativeBackend.fromEnv({}, home);
  await backend.setServer("https://vault.bitwarden.eu");
  await expect(
    backend.login({ email: "a@example.test", password: "pw", interactive: false }),
  ).rejects.toThrow();

  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers).toMatchObject({
    "Bitwarden-Client-Name": "cli",
    "Bitwarden-Client-Version": expect.stringMatching(/^\d{4}\.\d+\.\d+$/),
    "Device-Type": expect.stringMatching(/^\d+$/),
  });
});
