import { AsyncLocalStorage } from "node:async_hooks";
import {
  BwCliBackend,
  createSessionStore,
  EnvkitError,
  envkitHome,
  idleTimeoutFromEnv,
  MemorySessionStore,
  SessionManager,
  type Env,
  type VaultBackend,
} from "@envkit/core";
import * as clack from "@clack/prompts";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  text(message: string, options?: { placeholder?: string; initialValue?: string }): Promise<string>;
  password(message: string): Promise<string>;
  select<T>(message: string, options: SelectOption<T>[]): Promise<T>;
  confirm(message: string): Promise<boolean>;
}

/** Everything a command needs from the outside world; tests replace any of it. */
export interface CliContext {
  output: Output;
  env: Env;
  /** Directory commands treat as the project directory. */
  cwd: string;
  /** Everything piped into envkit's stdin, or undefined when stdin is a terminal. */
  readStdin(): Promise<string | undefined>;
  /** Whether envkit may prompt. False in CI and when stdin/stdout aren't terminals. */
  interactive: boolean;
  prompt: Prompter;
  backend(): VaultBackend;
  sessions(): Promise<SessionManager>;
  /** Set by commands that pass through a child's exit code (`envkit run`). */
  exitCode?: number;
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
    const value = await clack.text({
      message,
      placeholder: options?.placeholder,
      initialValue: options?.initialValue,
    });
    return unwrap(value);
  },
  async password(message) {
    return unwrap(await clack.password({ message }));
  },
  async select<T>(message: string, options: SelectOption<T>[]): Promise<T> {
    // clack's option type is conditional on T; the shape is the same.
    const value = await clack.select<T>({
      message,
      options: options as Parameters<typeof clack.select<T>>[0]["options"],
    });
    return unwrap(value) as T;
  },
  async confirm(message) {
    return unwrap(await clack.confirm({ message, initialValue: false }));
  },
};

async function readProcessStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  let text = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) text += chunk as string;
  return text;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new EnvkitError("Cancelled", { exitCode: 130 });
  return value as Exclude<T, symbol>;
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
    cwd: process.cwd(),
    readStdin: readProcessStdin,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !env.CI,
    prompt: clackPrompter,
    backend: () => (backend ??= BwCliBackend.fromEnv(env, home)),
    sessions: () =>
      (sessions ??= (
        env.ENVKIT_SESSION_STORE === "memory"
          ? Promise.resolve(new MemorySessionStore())
          : createSessionStore(home)
      ).then((store) => new SessionManager(store, { idleTimeoutMs: idleTimeoutFromEnv(env) }))),
    ...overrides,
  };
}
