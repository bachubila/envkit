import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySessionStore, SessionManager } from "@envkit/core";
import { onTestFinished } from "vite-plus/test";
import { FakeVault, type FakeAccount } from "@envkit/testkit";
import type { CliContext, Prompter } from "../src/context.ts";
import { run } from "../src/run.ts";

export const ALICE: FakeAccount = {
  email: "alice@example.test",
  password: "correct horse",
  clientId: "user.alice",
  clientSecret: "alice-secret",
};
export const SERVER = "https://vault.example.test";

/** Prompter that answers from a queue and records what it was asked. */
export function scriptedPrompts(answers: string[] = []) {
  const queue = [...answers];
  const asked: string[] = [];
  const next = async (message: string) => {
    asked.push(message);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${message}`);
    return answer;
  };
  const prompt: Prompter = {
    text: next,
    password: next,
    // Answer with the label of the option to pick.
    async select<T>(message: string, options: { value: T; label: string }[]) {
      const label = await next(message);
      const option = options.find((candidate) => candidate.label === label);
      if (!option) throw new Error(`no option "${label}" for prompt: ${message}`);
      return option.value;
    },
  };
  return { prompt, asked, remaining: () => queue.length };
}

/** An in-process envkit wired to a FakeVault, with captured output. */
export function harness(
  options: {
    env?: Record<string, string>;
    interactive?: boolean;
    answers?: string[];
    persistentStore?: boolean;
    vault?: FakeVault;
    /** Project directory; defaults to a fresh temp dir removed after the test. */
    cwd?: string;
  } = {},
) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "envkit-cli-"));
  if (!options.cwd) onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const vault = options.vault ?? new FakeVault([ALICE]);
  const store = new MemorySessionStore();
  if (options.persistentStore)
    Object.assign(store, { persistent: true, description: "test keychain" });
  const sessions = new SessionManager(store, { idleTimeoutMs: 30 * 60_000 });
  const prompts = scriptedPrompts(options.answers);
  let out: string[] = [];
  let err: string[] = [];

  const context: Partial<CliContext> = {
    output: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    env: options.env ?? {},
    cwd,
    interactive: options.interactive ?? false,
    prompt: prompts.prompt,
    backend: () => vault,
    sessions: async () => sessions,
  };

  return {
    vault,
    sessions,
    cwd,
    prompts,
    envkit: async (...args: string[]) => {
      out = [];
      err = [];
      const code = await run(args, context);
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    },
  };
}
