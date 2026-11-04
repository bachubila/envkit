import { describe, expect, test } from "vite-plus/test";
import { needsSync, syncIntervalFromEnv } from "../src/index.ts";

describe("needsSync", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  test.each([
    [undefined, true],
    ["2026-11-04T11:56:00Z", false],
    ["2026-11-04T11:55:00Z", true],
    ["2026-11-03T12:00:00Z", true],
  ])("last sync %s → %s", (lastSync, expected) => {
    expect(needsSync(lastSync ? new Date(lastSync) : undefined, 5 * 60_000, now)).toBe(expected);
  });

  test("interval 0 always syncs", () => {
    expect(needsSync(new Date(now), 0, now)).toBe(true);
  });
});

describe("syncIntervalFromEnv", () => {
  test.each([
    [undefined, 5],
    ["", 5],
    ["0", 0],
    ["30", 30],
    ["-1", 5],
    ["soon", 5],
  ])("ENVKIT_SYNC_INTERVAL_MINUTES=%j → %i minutes", (value, minutes) => {
    expect(syncIntervalFromEnv({ ENVKIT_SYNC_INTERVAL_MINUTES: value })).toBe(minutes * 60_000);
  });
});
