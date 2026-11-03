import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake `bw` prints for one command. Objects are JSON-encoded to stdout. */
export interface FakeBwResponse {
  stdout?: string | object;
  stderr?: string;
  code?: number;
}

/** One recorded invocation of the fake `bw`. */
export interface FakeBwCall {
  args: string[];
  env: Record<string, string | undefined>;
  stdin: string;
}

export interface FakeBw {
  /** Path to the executable; pass it as `bwPath`. */
  path: string;
  /**
   * Sets the response for a command, keyed by its leading args, e.g. "status",
   * "list organizations", "get item <id>". The longest matching key wins.
   */
  respond(command: string, response: FakeBwResponse): Promise<void>;
  calls(): Promise<FakeBwCall[]>;
  cleanup(): Promise<void>;
}

// Env vars recorded per call. Everything else is dropped to keep assertions readable.
const RECORDED_ENV = [
  "BW_SESSION",
  "BW_CLIENTID",
  "BW_CLIENTSECRET",
  "BITWARDENCLI_APPDATA_DIR",
  "ENVKIT_BW_PASSWORD",
];

const SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
const env = Object.fromEntries(${JSON.stringify(RECORDED_ENV)}.map((name) => [name, process.env[name]]));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, env, stdin }) + "\\n");
const responses = JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8"));
const positional = args.filter((arg) => !arg.startsWith("--"));
let response;
for (let n = positional.length; n > 0 && !response; n--) response = responses[positional.slice(0, n).join(" ")];
if (args[0] === "--version") response = responses["--version"];
if (!response) {
  process.stdout.write(JSON.stringify({ success: false, message: "fake bw: no response for " + args.join(" ") }));
  process.exit(1);
}
if (response.stderr) process.stderr.write(response.stderr);
if (response.stdout !== undefined) {
  process.stdout.write(typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout));
}
process.exit(response.code ?? 0);
`;

/** Creates a scriptable stand-in for the `bw` CLI in a temp directory. */
export async function createFakeBw(version = "2026.10.0"): Promise<FakeBw> {
  const dir = await mkdtemp(join(tmpdir(), "envkit-fake-bw-"));
  const responsesPath = join(dir, "responses.json");
  const responses: Record<string, FakeBwResponse> = { "--version": { stdout: `${version}\n` } };

  await writeFile(join(dir, "fake-bw.cjs"), SCRIPT);
  await writeFile(responsesPath, JSON.stringify(responses));
  await writeFile(join(dir, "calls.jsonl"), "");
  const path = join(dir, "bw");
  await writeFile(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-bw.cjs")}" "$@"\n`,
  );
  await chmod(path, 0o755);

  return {
    path,
    async respond(command, response) {
      responses[command] = response;
      await writeFile(responsesPath, JSON.stringify(responses));
    },
    async calls() {
      const lines = (await readFile(join(dir, "calls.jsonl"), "utf8")).split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as FakeBwCall);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
