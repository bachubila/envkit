import type { Env } from "./paths.ts";

/** Shorter lines aren't masked: masking `3000` or `true` would hide unrelated log text. */
export const MIN_MASKED_LENGTH = 4;

export function isGithubActions(env: Env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/**
 * GitHub Actions `::add-mask::` workflow commands that hide `values` in the
 * job log. The runner masks single lines, so a multi-line value gets one
 * command per line.
 */
export function githubMaskCommands(values: Iterable<string>): string[] {
  const lines = new Set<string>();
  for (const value of values) {
    for (const line of value.split(/\r\n|\r|\n/)) {
      if (line.trim().length >= MIN_MASKED_LENGTH) lines.add(line);
    }
  }
  return [...lines].map((line) => `::add-mask::${escapeCommandData(line)}`);
}

// https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
function escapeCommandData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
