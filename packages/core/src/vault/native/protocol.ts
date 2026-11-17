// Bitwarden's DeviceType: WindowsCLI, MacOsCLI, LinuxCLI.
export const DEVICE_TYPE =
  process.platform === "win32" ? "23" : process.platform === "darwin" ? "24" : "25";

/**
 * Bitwarden's own servers reject requests without these ("No client version header
 * found"); Vaultwarden ignores them. envkit identifies as the CLI it speaks the
 * protocol of, at a version recent enough for the server's feature checks.
 */
export const CLIENT_HEADERS: Record<string, string> = {
  "Bitwarden-Client-Name": "cli",
  "Bitwarden-Client-Version": "2026.10.0",
  "Device-Type": DEVICE_TYPE,
};
