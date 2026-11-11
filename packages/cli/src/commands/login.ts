import { EnvkitError, normalizeServerUrl } from "@envkit/core";
import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { requireSession, sessionNote, unlockVault } from "../session.ts";

export const login = defineCommand({
  meta: {
    name: "login",
    description: "Log in to your vault and unlock it",
  },
  args: {
    server: {
      type: "string",
      description: "Vault URL, e.g. https://vault.example.com (or ENVKIT_SERVER)",
      valueHint: "url",
    },
    email: {
      type: "string",
      description: "Account email (or ENVKIT_EMAIL)",
    },
    apikey: {
      type: "boolean",
      description: "Log in with a personal API key from BW_CLIENTID / BW_CLIENTSECRET",
    },
  },
  async run({ args }) {
    const context = useContext();
    const backend = context.backend();
    const requested = args.server ?? context.env.ENVKIT_SERVER;
    const serverUrl = requested ? normalizeServerUrl(requested) : undefined;
    const email = (args.email ?? context.env.ENVKIT_EMAIL)?.trim().toLowerCase();

    let status = await backend.status();
    if (status.state !== "unauthenticated") {
      if ((serverUrl && serverUrl !== status.serverUrl) || (email && email !== status.email)) {
        throw new EnvkitError(`Already logged in as ${status.email} on ${status.serverUrl}`, {
          hint: "Run `envkit logout` first to switch accounts.",
        });
      }
      await requireSession(context);
      context.output.stdout(`Already logged in as ${status.email} on ${status.serverUrl}.`);
      return;
    }

    const url = serverUrl ?? (await promptServerUrl());
    if (url !== status.serverUrl) await backend.setServer(url);

    const clientId = context.env.BW_CLIENTID;
    const clientSecret = context.env.BW_CLIENTSECRET;
    if (args.apikey) {
      if (!clientId || !clientSecret) {
        throw new EnvkitError("--apikey needs BW_CLIENTID and BW_CLIENTSECRET", {
          hint: "Find them in the web vault under Account settings → Security → Keys.",
        });
      }
      await backend.loginWithApiKey({ clientId, clientSecret });
      status = await backend.status();
      await unlockVault(context, status);
    } else {
      const accountEmail =
        email ?? (await promptOrFail("Email", "Pass --email or set ENVKIT_EMAIL."));
      const password =
        context.env.ENVKIT_PASSWORD ??
        (context.interactive
          ? await context.prompt.password("Master password")
          : failNonInteractive("Set ENVKIT_PASSWORD to log in without a terminal."));
      const session = await backend.login({
        email: accountEmail,
        password,
        interactive: context.interactive,
        ...(context.interactive
          ? {
              askCode: (kind: "authenticator" | "email" | "new-device") =>
                context.prompt.password(
                  kind === "authenticator"
                    ? "Authenticator code"
                    : kind === "new-device"
                      ? "New-device verification code from your email"
                      : "Two-step login code from your email",
                ),
            }
          : {}),
      });
      status = await backend.status();
      await (await context.sessions()).save(session, status);
    }

    context.output.stdout(`Logged in as ${status.email} on ${status.serverUrl}.`);
    context.output.stdout(await sessionNote(context));

    async function promptServerUrl(): Promise<string> {
      return normalizeServerUrl(
        await promptOrFail("Vault URL", "Pass --server <url> or set ENVKIT_SERVER.", {
          placeholder: "https://vault.example.com",
        }),
      );
    }

    async function promptOrFail(
      message: string,
      hint: string,
      options?: { placeholder?: string },
    ): Promise<string> {
      if (!context.interactive) failNonInteractive(hint);
      return context.prompt.text(message, options);
    }
  },
});

function failNonInteractive(hint: string): never {
  throw new EnvkitError("Missing login details and no terminal to ask for them", { hint });
}
