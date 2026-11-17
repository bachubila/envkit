import { beforeEach, expect, test, vi } from "vite-plus/test";
import { checkServer } from "../src/index.ts";
import { send } from "../src/vault/native/http.ts";

vi.mock("../src/vault/native/http.ts", async (original) => ({
  ...(await original<typeof import("../src/vault/native/http.ts")>()),
  send: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(send).mockReset().mockResolvedValue({ version: "test" });
});

test("probes a vault under a path with protocol headers and no credentials", async () => {
  await checkServer("https://vault.example.test/bitwarden/", {
    ENVKIT_PASSWORD: "do-not-send",
    BW_CLIENTSECRET: "do-not-send",
  });
  expect(send).toHaveBeenCalledWith(
    {
      method: "GET",
      url: "https://vault.example.test/bitwarden/api/config",
      timeoutMs: 5000,
      headers: expect.objectContaining({ "Bitwarden-Client-Name": "cli" }),
    },
    undefined,
  );
  expect(JSON.stringify(vi.mocked(send).mock.calls)).not.toContain("do-not-send");
});
test("refuses plaintext URLs before a request", async () => {
  await expect(checkServer("http://vault.example.test", {})).rejects.toThrow("https");
  expect(send).not.toHaveBeenCalled();
});
test.each([undefined, {}, { version: null }])(
  "rejects a non-vault response %j",
  async (response) => {
    vi.mocked(send).mockResolvedValue(response);
    await expect(checkServer("https://vault.example.test", {})).rejects.toThrow(
      "Bitwarden-compatible",
    );
  },
);
test("preserves TLS and connectivity failures for diagnostics", async () => {
  vi.mocked(send).mockRejectedValue(new Error("TLS failure"));
  await expect(checkServer("https://vault.example.test", {})).rejects.toThrow("TLS failure");
});
