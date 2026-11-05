import { request } from "node:https";
import { EnvkitError } from "../../errors.ts";

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Absolute URL. */
  url: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/** A non-2xx response. `message` is the server's own wording when it sent one. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;

  constructor(status: number, message: string, body: Record<string, unknown> | undefined) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const TIMEOUT_MS = 30_000;

/**
 * Sends a request and parses the JSON response (undefined for an empty body).
 * `ca` replaces the trusted certificates, for servers with a private CA.
 */
export function send<T>(req: HttpRequest, ca?: string[]): Promise<T> {
  const payload = req.form
    ? new URLSearchParams(req.form).toString()
    : req.json === undefined
      ? undefined
      : JSON.stringify(req.json);
  const headers: Record<string, string> = { accept: "application/json", ...req.headers };
  if (payload !== undefined) {
    headers["content-type"] = req.form ? "application/x-www-form-urlencoded" : "application/json";
  }
  const url = new URL(req.url);

  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: req.method, headers, ca, timeout: TIMEOUT_MS },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            body = undefined;
          }
          if (status >= 200 && status < 300) {
            resolve(body as T);
            return;
          }
          const object = isObject(body) ? body : undefined;
          const message = errorMessage(object) ?? (text.trim().slice(0, 200) || `HTTP ${status}`);
          reject(new HttpError(status, message, object));
        });
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timed out")));
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        new EnvkitError(`Can't reach the vault at ${url.origin}`, {
          hint: networkHint(error),
          cause: error,
        }),
      ),
    );
    outgoing.end(payload);
  });
}

/** Vaultwarden puts the message in different places for API and identity errors. */
function errorMessage(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const model = (body.errorModel ?? body.ErrorModel) as Record<string, unknown> | undefined;
  for (const candidate of [
    body.message,
    body.Message,
    model?.message,
    model?.Message,
    body.error_description,
    body.error,
  ]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function networkHint(error: NodeJS.ErrnoException): string {
  const code = error.code ?? "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `The server's TLS certificate isn't trusted (${code}). For a private CA, set NODE_EXTRA_CA_CERTS to its certificate.`;
  }
  if (code === "ENOTFOUND") return "Check the server URL (`envkit status`) and your network.";
  return `${error.message}. Check that the server is running and reachable.`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
