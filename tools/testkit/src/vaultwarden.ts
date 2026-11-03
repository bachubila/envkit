import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const VAULTWARDEN_IMAGE = "vaultwarden/server:1.37.5";

export interface Vaultwarden {
  /** https URL of the server. */
  url: string;
  /** Self-signed CA certificate; pass as NODE_EXTRA_CA_CERTS to `bw`. */
  caCertPath: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Vaultwarden in Docker with TLS (`bw` refuses plain http,
 * even on localhost). Requires `docker` and `openssl` on PATH.
 */
export async function startVaultwarden(): Promise<Vaultwarden> {
  const dir = await mkdtemp(join(tmpdir(), "envkit-vaultwarden-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  // The container user must be able to read the key.
  await run("chmod", ["644", keyPath, certPath]);

  const { stdout: id } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--env",
    "I_REALLY_WANT_VOLATILE_STORAGE=true",
    "--env",
    "SIGNUPS_ALLOWED=true",
    "--env",
    'ROCKET_TLS={certs="/tls/cert.pem",key="/tls/key.pem"}',
    "--volume",
    `${dir}:/tls:ro`,
    "--publish",
    "127.0.0.1::80",
    VAULTWARDEN_IMAGE,
  ]);
  const containerId = id.trim();
  const stop = async () => {
    await run("docker", ["rm", "--force", containerId]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  };

  try {
    const { stdout: port } = await run("docker", ["port", containerId, "80/tcp"]);
    const url = `https://localhost:${port.trim().split(":").at(-1)}`;
    await waitUntilAlive(url, certPath);
    return { url, caCertPath: certPath, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitUntilAlive(url: string, caCertPath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await run("curl", ["--silent", "--fail", "--cacert", caCertPath, `${url}/alive`]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Vaultwarden at ${url} did not become ready`);
}
