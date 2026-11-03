import { spawn } from "node:child_process";
import { join } from "node:path";
import { EnvkitError } from "../errors.ts";
import type { Env } from "../paths.ts";
import type {
  ApiKeyLoginOptions,
  Collection,
  LoginOptions,
  NewVaultItem,
  Organization,
  VaultBackend,
  VaultField,
  VaultItem,
  VaultState,
  VaultStatus,
} from "./backend.ts";

/** Oldest `bw` release envkit accepts. Integration tests run against @bitwarden/cli in devDependencies. */
export const MIN_BW_VERSION = "2026.1.0";

export const BW_INSTALL_HINT =
  "Install the Bitwarden CLI (`npm install -g @bitwarden/cli`, see https://bitwarden.com/help/cli/), " +
  "or point ENVKIT_BW_PATH at the `bw` executable.";

// The password reaches `bw` through this variable (`--passwordenv`), never argv.
const PASSWORD_ENV = "ENVKIT_BW_PASSWORD";

export interface BwCliOptions {
  /** Path to the `bw` executable. Defaults to `bw` on PATH. */
  bwPath?: string;
  /** Private `bw` data dir, so envkit never touches the user's own `bw` login. */
  appDataDir: string;
  /** Base environment for `bw` child processes. Defaults to `process.env`. */
  env?: Env;
}

interface ExecOptions {
  session?: string | undefined;
  /** Written to stdin. Used for item payloads so secret values stay out of argv. */
  input?: string;
  env?: Env;
  /** Inherit stdin/stderr so `bw` can prompt (2FA codes etc.). stdout stays piped. */
  interactive?: boolean;
}

interface BwResponse {
  success: boolean;
  message?: string;
  data?: unknown;
}

export class BwCliBackend implements VaultBackend {
  readonly #bwPath: string;
  readonly #appDataDir: string;
  readonly #env: Env;
  #versionCheck: Promise<void> | undefined;

  constructor(options: BwCliOptions) {
    this.#bwPath = options.bwPath ?? "bw";
    this.#appDataDir = options.appDataDir;
    this.#env = options.env ?? process.env;
  }

  static fromEnv(env: Env, envkitHome: string): BwCliBackend {
    return new BwCliBackend({
      bwPath: env.ENVKIT_BW_PATH,
      appDataDir: join(envkitHome, "bw"),
      env,
    });
  }

  async status(session?: string): Promise<VaultStatus> {
    const data = await this.#call<{ template: RawStatus }>(["status"], { session });
    const raw = data.template;
    return {
      state: raw.status,
      serverUrl: raw.serverUrl ?? undefined,
      email: raw.userEmail ?? undefined,
      userId: raw.userId ?? undefined,
      lastSync: raw.lastSync ? new Date(raw.lastSync) : undefined,
    };
  }

  async setServer(url: string): Promise<void> {
    await this.#call(["config", "server", url]);
  }

  async login({ email, password, interactive }: LoginOptions): Promise<string> {
    const data = await this.#call<{ raw?: string }>(
      ["login", email, "--passwordenv", PASSWORD_ENV],
      {
        env: { [PASSWORD_ENV]: password },
        interactive,
      },
    );
    return sessionKey(data);
  }

  async loginWithApiKey({ clientId, clientSecret }: ApiKeyLoginOptions): Promise<void> {
    await this.#call(["login", "--apikey"], {
      env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
    });
  }

  async unlock(password: string): Promise<string> {
    const data = await this.#call<{ raw?: string }>(["unlock", "--passwordenv", PASSWORD_ENV], {
      env: { [PASSWORD_ENV]: password },
    });
    return sessionKey(data);
  }

  async lock(): Promise<void> {
    await this.#call(["lock"]);
  }

  async logout(): Promise<void> {
    try {
      await this.#call(["logout"]);
    } catch (error) {
      if (error instanceof BwError && error.bwMessage === "You are not logged in.") return;
      throw error;
    }
  }

  async sync(session: string): Promise<void> {
    await this.#call(["sync"], { session });
  }

  async listOrganizations(session: string): Promise<Organization[]> {
    const data = await this.#call<{ data: RawOrganization[] }>(["list", "organizations"], {
      session,
    });
    return data.data.map(({ id, name }) => ({ id, name }));
  }

  async listCollections(session: string, organizationId?: string): Promise<Collection[]> {
    const args = ["list", "collections"];
    if (organizationId) args.push("--organizationid", organizationId);
    const data = await this.#call<{ data: RawCollection[] }>(args, { session });
    return data.data.map(({ id, organizationId, name }) => ({ id, organizationId, name }));
  }

  async getItem(session: string, id: string): Promise<VaultItem> {
    return toVaultItem(await this.#call<RawItem>(["get", "item", id], { session }));
  }

  async createItem(session: string, item: NewVaultItem): Promise<VaultItem> {
    const payload = {
      type: 2,
      secureNote: { type: 0 },
      favorite: false,
      reprompt: 0,
      ...item,
    };
    return toVaultItem(
      await this.#call<RawItem>(["create", "item"], { session, input: encode(payload) }),
    );
  }

  async updateItem(session: string, item: VaultItem): Promise<VaultItem> {
    // `bw edit` replaces the whole item, so start from the full stored item and
    // overwrite only the fields envkit owns.
    const current = await this.#call<RawItem>(["get", "item", item.id], { session });
    const payload = { ...current, name: item.name, notes: item.notes, fields: item.fields };
    return toVaultItem(
      await this.#call<RawItem>(["edit", "item", item.id], { session, input: encode(payload) }),
    );
  }

  /** Runs `bw <args> --response` and returns `data`, or throws a mapped error. */
  async #call<T = unknown>(args: string[], options: ExecOptions = {}): Promise<T> {
    await this.#ensureVersion();
    const flags = options.interactive ? ["--response"] : ["--response", "--nointeraction"];
    const { stdout, stderr } = await this.#exec([...args, ...flags], options);
    let response: BwResponse;
    try {
      response = JSON.parse(stdout) as BwResponse;
    } catch {
      throw new EnvkitError(`Unexpected output from \`bw ${args[0]}\``, {
        hint: lastLine(stderr) ?? lastLine(stdout),
      });
    }
    if (!response.success) throw toError(response.message ?? "unknown error", lastLine(stderr));
    return response.data as T;
  }

  #ensureVersion(): Promise<void> {
    this.#versionCheck ??= this.#exec(["--version"]).then(({ stdout }) => {
      const version = stdout.trim();
      if (compareVersions(version, MIN_BW_VERSION) < 0) {
        throw new EnvkitError(`bw ${version} is too old; envkit needs ${MIN_BW_VERSION} or newer`, {
          hint: BW_INSTALL_HINT,
        });
      }
    });
    return this.#versionCheck;
  }

  #exec(
    args: string[],
    { session, input, env, interactive }: ExecOptions = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const childEnv: Env = { ...this.#env, ...env, BITWARDENCLI_APPDATA_DIR: this.#appDataDir };
    delete childEnv.BW_SESSION;
    if (session) childEnv.BW_SESSION = session;

    return new Promise((resolve, reject) => {
      const child = spawn(this.#bwPath, args, {
        env: childEnv,
        stdio: [interactive ? "inherit" : "pipe", "pipe", interactive ? "inherit" : "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new EnvkitError(`Bitwarden CLI not found (\`${this.#bwPath}\`)`, {
                hint: BW_INSTALL_HINT,
                cause: error,
              })
            : error,
        );
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.end(input ?? "");
    });
  }
}

/** A failed `bw` command, translated into an actionable message where we know one. */
export class BwError extends EnvkitError {
  readonly bwMessage: string;

  constructor(bwMessage: string, message: string, hint?: string) {
    super(message, { hint });
    this.bwMessage = bwMessage;
  }
}

export function toError(bwMessage: string, detail?: string): BwError {
  const known: [RegExp, string, string?][] = [
    [/^Vault is locked/, "Vault is locked", "Run `envkit unlock`."],
    [/^You are not logged in/, "Not logged in", "Run `envkit login`."],
    [
      /^You are already logged in as (.+?)\.?$/,
      "Already logged in as $1",
      "Run `envkit logout` first.",
    ],
    [
      /^Username or password is incorrect/,
      "Email or master password is incorrect",
      "Check both and try again.",
    ],
    [/decryption operation failed|Invalid master password/i, "Incorrect master password"],
    [/^Not found/, "Item not found in the vault"],
    [
      /^Logout required before server config update/,
      "Cannot change server while logged in",
      "Run `envkit logout` first.",
    ],
    [/Insecure URL not allowed/, "The vault URL must use https://"],
  ];
  for (const [pattern, message, hint] of known) {
    const match = pattern.exec(bwMessage);
    if (match) return new BwError(bwMessage, message.replace("$1", match[1] ?? ""), hint);
  }
  return new BwError(bwMessage, `bw: ${bwMessage}`, detail);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function sessionKey(data: { raw?: string }): string {
  if (!data.raw) throw new EnvkitError("`bw` did not return a session key");
  return data.raw;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function lastLine(text: string): string | undefined {
  // `bw` logs Rust SDK errors ("ERROR bitwarden_crypto::...") before the real message.
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(ERROR|WARN|at) /.test(line));
  return lines.at(-1);
}

function toVaultItem(raw: RawItem): VaultItem {
  return {
    id: raw.id,
    organizationId: raw.organizationId ?? null,
    collectionIds: raw.collectionIds ?? [],
    name: raw.name,
    notes: raw.notes ?? null,
    fields: (raw.fields ?? []).map(({ name, value, type }) => ({ name, value, type })),
    revisionDate: raw.revisionDate,
  };
}

interface RawStatus {
  status: VaultState;
  serverUrl?: string | null;
  userEmail?: string | null;
  userId?: string | null;
  lastSync?: string | null;
}

interface RawOrganization {
  id: string;
  name: string;
}

interface RawCollection {
  id: string;
  organizationId: string;
  name: string;
}

interface RawItem {
  id: string;
  organizationId?: string | null;
  collectionIds?: string[];
  name: string;
  notes?: string | null;
  fields?: VaultField[];
  revisionDate: string;
  [key: string]: unknown;
}
