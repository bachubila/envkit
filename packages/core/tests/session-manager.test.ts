import { describe, expect, test } from "vite-plus/test";
import {
  idleTimeoutFromEnv,
  KeyringSessionStore,
  MemorySessionStore,
  SessionManager,
  type VaultStatus,
} from "../src/index.ts";

const alice: VaultStatus = {
  state: "locked",
  serverUrl: "https://vault.test",
  email: "alice@example.test",
  userId: "u1",
  lastSync: undefined,
};

function setup() {
  let now = 1_000_000;
  const store = new MemorySessionStore();
  const manager = new SessionManager(store, { idleTimeoutMs: 60_000, now: () => now });
  return { store, manager, advance: (ms: number) => (now += ms) };
}

describe("SessionManager", () => {
  test("returns a saved session for the same account", async () => {
    const { manager } = setup();
    await manager.save("key", alice);
    expect(await manager.get(alice)).toBe("key");
  });

  test("expires after the idle timeout", async () => {
    const { manager, store, advance } = setup();
    await manager.save("key", alice);
    advance(60_000);
    expect(await manager.get(alice)).toBeUndefined();
    expect(await store.get()).toBeUndefined();
  });

  test("using the session extends it; peeking does not", async () => {
    const { manager, advance } = setup();
    await manager.save("key", alice);
    advance(50_000);
    expect(await manager.get(alice, { touch: false })).toBe("key");
    advance(5_000);
    expect(await manager.get(alice)).toBe("key");
    advance(50_000); // 105s after save, but only 50s after last use
    expect(await manager.get(alice)).toBe("key");
  });

  test("ignores and drops a session for another account or server", async () => {
    const { manager, store } = setup();
    await manager.save("key", alice);
    expect(await manager.get({ ...alice, email: "bob@example.test" })).toBeUndefined();
    expect(await store.get()).toBeUndefined();

    await manager.save("key", alice);
    expect(await manager.get({ ...alice, serverUrl: "https://other.test" })).toBeUndefined();
  });

  test("peek returns the stored session with its account and last sync, without a status", async () => {
    const { manager, advance } = setup();
    await manager.save("key", { ...alice, lastSync: new Date(900_000) });
    expect(await manager.peek()).toMatchObject({
      key: "key",
      email: "alice@example.test",
      lastSync: 900_000,
    });
    advance(30_000);
    await manager.recordSync();
    expect((await manager.peek())?.lastSync).toBe(1_030_000);
  });

  test("peek drops an idle session and extends a live one", async () => {
    const { manager, advance } = setup();
    await manager.save("key", alice);
    advance(50_000);
    expect(await manager.peek()).toBeDefined();
    advance(50_000);
    expect(await manager.peek()).toBeDefined();
    advance(60_000);
    expect(await manager.peek()).toBeUndefined();
    expect(await manager.get(alice)).toBeUndefined();
  });

  test("recordSync without a session does nothing", async () => {
    const { manager } = setup();
    await manager.recordSync();
    expect(await manager.peek()).toBeUndefined();
  });

  test("clear forgets the session", async () => {
    const { manager } = setup();
    await manager.save("key", alice);
    await manager.clear();
    expect(await manager.get(alice)).toBeUndefined();
  });
});

describe("KeyringSessionStore", () => {
  function fakeEntry() {
    let value: string | null = null;
    return {
      getPassword: async () => value,
      setPassword: async (next: string) => void (value = next),
      deleteCredential: async () => ((value = null), true),
      raw: () => value,
      corrupt: (next: string) => void (value = next),
    };
  }

  test("round-trips a session as JSON", async () => {
    const entry = fakeEntry();
    const store = new KeyringSessionStore(entry);
    const session = { key: "k", serverUrl: "https://v", email: "a@b", expiresAt: 5 };
    await store.set(session);
    expect(JSON.parse(entry.raw() ?? "")).toEqual(session);
    expect(await store.get()).toEqual(session);
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });

  test("treats unreadable entries as no session", async () => {
    const entry = fakeEntry();
    const store = new KeyringSessionStore(entry);
    entry.corrupt("not json");
    expect(await store.get()).toBeUndefined();
    entry.corrupt(JSON.stringify({ key: 1 }));
    expect(await store.get()).toBeUndefined();
  });

  test("keeps lastSync and ignores a malformed one", async () => {
    const entry = fakeEntry();
    const store = new KeyringSessionStore(entry);
    const session = { key: "k", serverUrl: "https://v", email: "a@b", expiresAt: 5 };
    entry.corrupt(JSON.stringify({ ...session, lastSync: 4 }));
    expect(await store.get()).toEqual({ ...session, lastSync: 4 });
    entry.corrupt(JSON.stringify({ ...session, lastSync: "yesterday" }));
    expect(await store.get()).toEqual(session);
  });
});

describe("idleTimeoutFromEnv", () => {
  test.each([
    [undefined, 60],
    ["15", 15],
    ["0", 60],
    ["abc", 60],
  ])("ENVKIT_SESSION_IDLE_MINUTES=%s → %i minutes", (value, minutes) => {
    expect(idleTimeoutFromEnv({ ENVKIT_SESSION_IDLE_MINUTES: value })).toBe(minutes * 60_000);
  });
});
