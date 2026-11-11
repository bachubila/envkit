import { NativeBackend } from "@envkit/core";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { startTestServer, type TestServer } from "./setup.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server?.stop());

test("native login completes Vaultwarden authenticator verification and rejects non-interactive login", async () => {
  const code = await server.api.enableAuthenticator(server.account);
  const backend = NativeBackend.fromEnv(server.env, await server.tempHome());
  await backend.setServer(server.vaultwarden.url);
  const askCode = vi.fn(async () => code());
  await expect(backend.login({ ...server.account, interactive: false, askCode })).rejects.toThrow(
    "two-step login",
  );
  expect(askCode).not.toHaveBeenCalled();
  const session = await backend.login({ ...server.account, interactive: true, askCode });
  expect(askCode).toHaveBeenCalledWith("authenticator");
  expect(await backend.status(session)).toMatchObject({
    state: "unlocked",
    email: server.account.email,
  });
});
