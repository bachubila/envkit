import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { EnvkitError } from "../errors.ts";
import { conflictError, toError, trashedError, VaultError } from "./errors.ts";
import type { Env } from "../paths.ts";
import type {
  ApiKeyLoginOptions,
  Collection,
  ItemFilter,
  LoginOptions,
  NewVaultItem,
  Organization,
  OrganizationRole,
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
  /**
   * File that remembers the checked `bw` version, keyed by the executable's
   * path, size and mtime, so most commands skip `bw --version` (about 1 s).
   */
  versionCachePath?: string;
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
  readonly #versionCachePath: string | undefined;
  #versionCheck: Promise<void> | undefined;

  constructor(options: BwCliOptions) {
    this.#bwPath = options.bwPath ?? "bw";
    this.#appDataDir = options.appDataDir;
    this.#env = options.env ?? process.env;
    this.#versionCachePath = options.versionCachePath;
  }

  static fromEnv(env: Env, envkitHome: string): BwCliBackend {
    return new BwCliBackend({
      bwPath: env.ENVKIT_BW_PATH,
      appDataDir: join(envkitHome, "bw"),
      env,
      versionCachePath: join(envkitHome, "bw-version.json"),
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
      if (error instanceof VaultError && error.vaultMessage === "You are not logged in.") return;
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
    return data.data.map(({ id, name, type }) => ({ id, name, role: ROLES[type] ?? "custom" }));
  }

  async listCollections(session: string, organizationId?: string): Promise<Collection[]> {
    const args = ["list", "collections"];
    if (organizationId) args.push("--organizationid", organizationId);
    const data = await this.#call<{ data: RawCollection[] }>(args, { session });
    return data.data.map(({ id, organizationId, name }) => ({ id, organizationId, name }));
  }

  async createCollection(
    session: string,
    organizationId: string,
    name: string,
  ): Promise<Collection> {
    const payload = { organizationId, name, externalId: null, groups: [], users: [] };
    const data = await this.#call<RawCollection>(
      ["create", "org-collection", "--organizationid", organizationId],
      { session, input: encode(payload) },
    );
    return { id: data.id, organizationId: data.organizationId, name: data.name };
  }

  async listItems(session: string, filter: ItemFilter = {}): Promise<VaultItem[]> {
    const args = ["list", "items"];
    if (filter.organizationId) args.push("--organizationid", filter.organizationId);
    if (filter.collectionId) args.push("--collectionid", filter.collectionId);
    if (filter.search) args.push("--search", filter.search);
    const data = await this.#call<{ data: RawItem[] }>(args, { session });
    return data.data.filter((item) => !item.deletedDate).map(toVaultItem);
  }

  async getItem(session: string, id: string): Promise<VaultItem> {
    const raw = await this.#call<RawItem>(["get", "item", id], { session });
    // `bw get` still returns trashed items.
    if (raw.deletedDate) throw trashedError();
    return toVaultItem(raw);
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
    // The server rejects edits based on a stale local copy, but not edits whose
    // contents were read before a sync. Compare against what the caller read.
    if (current.revisionDate !== item.revisionDate) throw conflictError();
    const payload = { ...current, name: item.name, notes: item.notes, fields: item.fields };
    return toVaultItem(
      await this.#call<RawItem>(["edit", "item", item.id], { session, input: encode(payload) }),
    );
  }

  async deleteItem(session: string, id: string): Promise<void> {
    await this.#call(["delete", "item", id], { session });
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
    this.#versionCheck ??= this.#checkVersion();
    return this.#versionCheck;
  }

  async #checkVersion(): Promise<void> {
    const cachePath = this.#versionCachePath;
    const fingerprint = cachePath
      ? await executableFingerprint(this.#bwPath, this.#env)
      : undefined;
    if (cachePath && fingerprint) {
      const cached = await readJson<{ fingerprint?: string; version?: string }>(cachePath);
      if (
        cached?.fingerprint === fingerprint &&
        typeof cached.version === "string" &&
        compareVersions(cached.version, MIN_BW_VERSION) >= 0
      ) {
        return;
      }
    }
    const version = (await this.#exec(["--version"])).stdout.trim();
    if (compareVersions(version, MIN_BW_VERSION) < 0) {
      throw new EnvkitError(`bw ${version} is too old; envkit needs ${MIN_BW_VERSION} or newer`, {
        hint: BW_INSTALL_HINT,
      });
    }
    if (cachePath && fingerprint) {
      // Only a speed-up: a cache that can't be written just means checking next time.
      await mkdir(dirname(cachePath), { recursive: true })
        .then(() => writeFile(cachePath, JSON.stringify({ fingerprint, version })))
        .catch(() => {});
    }
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
    fields: (raw.fields ?? []).map(({ name, value, type }) => ({
      name,
      value: value ?? null,
      type,
    })),
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
  type: number;
}

// Bitwarden's OrganizationUserType.
const ROLES: Record<number, OrganizationRole> = {
  0: "owner",
  1: "admin",
  2: "user",
  3: "manager",
  4: "custom",
};

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
  deletedDate?: string | null;
  [key: string]: unknown;
}

/**
 * Identifies the installed `bw` (real path, size, mtime), or undefined when it
 * can't be found. An upgrade changes the size or mtime, so the version is checked again.
 */
async function executableFingerprint(command: string, env: Env): Promise<string | undefined> {
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [command]
      : (env.PATH ?? env.Path ?? "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((dir) => executableNames(command, env).map((name) => join(dir, name)));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const info = await stat(path);
      if (info.isFile()) return `${path}:${info.size}:${info.mtimeMs}`;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

function executableNames(command: string, env: Env): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => command + extension.toLowerCase())];
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
