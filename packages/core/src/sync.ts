export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

/**
 * Whether the local copy of the vault is old enough to sync before reading.
 * A teammate's change shows up after at most one interval (or `envkit sync`).
 */
export function needsSync(
  lastSync: Date | undefined,
  intervalMs: number,
  now: number = Date.now(),
): boolean {
  return !lastSync || now - lastSync.getTime() >= intervalMs;
}

/** Reads ENVKIT_SYNC_INTERVAL_MINUTES; 0 means always sync. */
export function syncIntervalFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.ENVKIT_SYNC_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return (
    (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SYNC_INTERVAL_MINUTES) * 60_000
  );
}
