/**
 * An expected, user-facing failure. The CLI prints only the message (and hint)
 * for these instead of a stack trace, and exits with `exitCode`.
 */
export class EnvkitError extends Error {
  override readonly name = "EnvkitError";
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { hint?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isEnvkitError(error: unknown): error is EnvkitError {
  return error instanceof EnvkitError;
}
