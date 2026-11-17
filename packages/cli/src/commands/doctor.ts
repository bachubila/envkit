import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  checkServer,
  EnvkitError,
  findConfig,
  normalizeServerUrl,
  type LoadedConfig,
  type VaultStatus,
} from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { currentSession } from "../session.ts";

const exec = promisify(execFile);
type CheckState = "pass" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  state: CheckState;
  message: string;
  hint?: string;
}

export const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Check vault connectivity, login, project config and .env gitignore coverage",
  },
  args: {
    json: { type: "boolean", description: "Print machine-readable diagnostics" },
    offline: { type: "boolean", description: "Skip the server connectivity check" },
  },
  async run({ args }) {
    const context = useContext();
    const checks: Check[] = [];
    const add = (name: string, state: CheckState, message: string, hint?: string) =>
      checks.push({ name, state, message, ...(hint ? { hint } : {}) });

    let loaded: LoadedConfig | undefined;
    try {
      loaded = await findConfig(context.cwd);
      if (loaded) {
        normalizeServerUrl(loaded.config.server);
        add("config", "pass", "Project configuration is valid.");
      } else {
        add(
          "config",
          "warn",
          "No .envkit.json found.",
          "Run `envkit init` or `envkit link <project>` in your project.",
        );
      }
    } catch {
      add(
        "config",
        "fail",
        "Project configuration is invalid or unreadable.",
        "Check .envkit.json for valid JSON, required fields and an HTTPS server URL.",
      );
    }

    let vault: VaultStatus | undefined;
    try {
      // bw status also verifies the executable and minimum supported version.
      vault = await context.backend().status();
      add("backend", "pass", `${context.env.ENVKIT_BACKEND || "native"} backend is available.`);
    } catch (error) {
      add(
        "backend",
        "fail",
        "Could not inspect the vault backend.",
        error instanceof EnvkitError
          ? [error.message, error.hint].filter(Boolean).join(" ")
          : "Check ENVKIT_BACKEND and your local vault state; for bw, check its installation and version.",
      );
    }

    if (vault) {
      if (vault.state === "unauthenticated") {
        add(
          "login",
          "fail",
          "Not logged in.",
          "Run `envkit login`. In CI, configure ENVKIT_SERVER and your login credentials.",
        );
      } else {
        try {
          const session = await currentSession(context, vault, { touch: false });
          add(
            "login",
            session ? "pass" : "warn",
            session ? "Vault is unlocked." : "Vault is locked.",
            session ? undefined : "Run `envkit unlock` when you need secrets.",
          );
        } catch {
          add("login", "fail", "Could not validate the saved session.", "Run `envkit unlock`.");
        }
      }
    } else {
      add("login", "skip", "Login state could not be checked.");
    }

    try {
      const { store } = await context.sessions();
      add(
        "session-store",
        store.persistent ? "pass" : "warn",
        store.persistent ? "OS keychain is available." : "Sessions are stored only in memory.",
        store.persistent
          ? undefined
          : "Use a working OS keychain, or supply ENVKIT_PASSWORD or ENVKIT_SESSION between commands.",
      );
    } catch {
      add(
        "session-store",
        "fail",
        "Could not initialize session storage.",
        "Check your OS keychain or set ENVKIT_SESSION_STORE=memory.",
      );
    }

    try {
      const server = context.env.ENVKIT_SERVER || vault?.serverUrl || loaded?.config.server;
      if (!server) {
        add(
          "server",
          "fail",
          "No vault server is configured.",
          "Run `envkit login --server <url>` or set ENVKIT_SERVER.",
        );
      } else {
        const normalized = normalizeServerUrl(server);
        if (loaded && normalized !== normalizeServerUrl(loaded.config.server)) {
          add(
            "server-match",
            "fail",
            "The selected server differs from the project's server.",
            "Check ENVKIT_SERVER, `envkit status` and .envkit.json before using this project.",
          );
        }
        if (
          loaded &&
          vault?.serverUrl &&
          normalizeServerUrl(vault.serverUrl) !== normalizeServerUrl(loaded.config.server) &&
          normalizeServerUrl(vault.serverUrl) !== normalized
        ) {
          add(
            "account-server",
            "fail",
            "The logged-in account uses a different server from the project.",
            "Log out and log in to the project's server.",
          );
        }
        if (args.offline) {
          add("server", "skip", "Connectivity was skipped (--offline).");
        } else {
          await checkServer(normalized, context.env);
          add("server", "pass", "Vault is reachable over HTTPS.");
        }
      }
    } catch (error) {
      add(
        "server",
        "fail",
        "Vault URL, connectivity or TLS check failed.",
        error instanceof EnvkitError && error.hint
          ? error.hint
          : "Check the vault URL, network and TLS certificate; use NODE_EXTRA_CA_CERTS for a private CA.",
      );
    }

    const cwd = loaded ? dirname(loaded.path) : context.cwd;
    try {
      await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
      const path = join(cwd, ".env");
      let tracked = false;
      try {
        await exec("git", ["ls-files", "--error-unmatch", "--", path], { cwd });
        tracked = true;
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
      if (tracked) {
        add(
          "gitignore",
          "fail",
          ".env is tracked by git.",
          "Remove .env from the index and add it to .gitignore. Rotate any committed secrets.",
        );
      } else {
        try {
          await exec("git", ["check-ignore", "--quiet", "--no-index", "--", path], { cwd });
          add("gitignore", "pass", ".env is ignored by git.");
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
          add(
            "gitignore",
            "warn",
            ".env is not ignored by git.",
            "Add .env to .gitignore before using `envkit pull --out .env`.",
          );
        }
      }
    } catch {
      add(
        "gitignore",
        "warn",
        "Git coverage could not be checked.",
        "Run doctor inside a Git repository with git installed.",
      );
    }

    const ok = !checks.some((check) => check.state === "fail");
    context.exitCode = ok ? 0 : 1;
    if (args.json) {
      context.output.stdout(JSON.stringify({ ok, checks }));
    } else {
      for (const check of checks) {
        context.output.stdout(`[${check.state}] ${check.name}: ${check.message}`);
        if (check.hint) context.output.stdout(`  ${check.hint}`);
      }
    }
  },
});
