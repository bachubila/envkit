import { AsyncLocalStorage } from "node:async_hooks";
import {
  BwCliBackend,
  createSessionStore,
  EnvkitError,
  envkitHome,
  idleTimeoutFromEnv,
  SessionManager,
  type Env,
  type VaultBackend,
} from "@envkit/core";
import * as clack from "@clack/prompts";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface Prompter {
  text(message: string, options?: { placeholder?: string }): Promise<string>;
  password(message: string): Promise<string>;
}

/** Everything a command needs from the outside world; tests replace any of it. */
export interface CliContext {
  output: Output;
  env: Env;
  /** Whether envkit may prompt. False in CI and when stdin/stdout aren't terminals. */
  interactive: boolean;
  prompt: Prompter;
  backend(): VaultBackend;
  sessions(): Promise<SessionManager>;
}

const storage = new AsyncLocalStorage<CliContext>();

export function useContext(): CliContext {
  const context = storage.getStore();
  if (!context) throw new Error("envkit command ran outside of run()");
  return context;
}

export function withContext<T>(context: CliContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export const processOutput: Output = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

export const clackPrompter: Prompter = {
  async text(message, options) {
    return unwrap(await clack.text({ message, placeholder: options?.placeholder }));
  },
  async password(message) {
    return unwrap(await clack.password({ message }));
  },
};

function unwrap(value: string | symbol): string {
  if (typeof value !== "string" || clack.isCancel(value)) {
    throw new EnvkitError("Cancelled", { exitCode: 130 });
  }
  return value;
}

/** The real context. Backend and session store are created on first use, so `--help` stays fast. */
export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  const env = overrides.env ?? process.env;
  const home = envkitHome(env);
  let backend: VaultBackend | undefined;
  let sessions: Promise<SessionManager> | undefined;
  return {
    output: processOutput,
    env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !env.CI,
    prompt: clackPrompter,
    backend: () => (backend ??= BwCliBackend.fromEnv(env, home)),
    sessions: () =>
      (sessions ??= createSessionStore(home).then(
        (store) => new SessionManager(store, { idleTimeoutMs: idleTimeoutFromEnv(env) }),
      )),
    ...overrides,
  };
}
