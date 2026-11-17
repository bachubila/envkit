import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE = "axllent/mailpit:v1.27.10";

/** A private SMTP sink for disposable accounts; never forwards mail. */
export async function startMailpit() {
  const network = `envkit-mail-${randomUUID()}`;
  await run("docker", ["network", "create", network]);
  let containerId: string | undefined;
  const stop = async () => {
    if (containerId) await run("docker", ["rm", "--force", containerId]).catch(() => {});
    await run("docker", ["network", "rm", network]).catch(() => {});
  };
  try {
    const { stdout } = await run("docker", [
      "run",
      "--detach",
      "--rm",
      "--network",
      network,
      "--network-alias",
      "mail",
      "--publish",
      "127.0.0.1::8025",
      IMAGE,
    ]);
    containerId = stdout.trim();
    const { stdout: port } = await run("docker", ["port", containerId, "8025/tcp"]);
    const url = `http://127.0.0.1:${port.trim().split(":").at(-1)}`;
    const seen = new Set<string>();
    return {
      network,
      host: "mail",
      stop,
      /** Consume the next OTP delivered to this account, ignoring notification mail. */
      async code(email: string): Promise<string> {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const response = await fetch(`${url}/api/v1/messages`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) throw new Error("Mailpit message listing failed");
          const { messages } = (await response.json()) as {
            messages: { ID: string; To: { Address: string }[] }[];
          };
          for (const message of messages) {
            if (seen.has(message.ID) || !message.To.some((to) => to.Address === email)) continue;
            const detail = await fetch(`${url}/api/v1/message/${message.ID}`);
            if (!detail.ok) throw new Error("Mailpit message reading failed");
            const body = (await detail.json()) as { Text: string };
            seen.add(message.ID);
            const code = /\b\d{6}\b/.exec(body.Text)?.[0];
            if (code) return code;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Verification email was not delivered");
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
