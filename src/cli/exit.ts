export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_AUTH = 2;
export const EXIT_REMOTE = 3;

export type ExitCode = 0 | 1 | 2 | 3;

export type JsonError = {
  readonly code: string;
  readonly message: string;
};

export type JsonResult = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: JsonError;
};

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;

  constructor(exitCode: ExitCode, code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function usage(message: string): CliError {
  return new CliError(EXIT_USAGE, "invalid_request", message);
}

export function authError(code: string, message: string): CliError {
  return new CliError(EXIT_AUTH, code, message);
}

export function remoteError(code: string, message: string): CliError {
  return new CliError(EXIT_REMOTE, code, message);
}

export function mapHttpStatus(status: number, code: string): CliError {
  if (status === 400) {
    return usage(code);
  }
  if (status === 401 || status === 403 || status === 409 || status === 410 || status === 422) {
    return authError(code, code);
  }
  if (status === 429 || status === 503) {
    return remoteError(code, code);
  }
  if (status >= 500) {
    return remoteError(code || "grant_unavailable", code || "grant_unavailable");
  }
  return usage(code);
}

export type CliWriter = {
  write(chunk: string): boolean;
};

export function printResult(
  json: boolean,
  stdout: CliWriter,
  stderr: CliWriter,
  result: JsonResult,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.ok) {
    if (result.data !== undefined) {
      stdout.write(
        `${typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)}\n`,
      );
    }
    return;
  }
  stderr.write(`${result.error?.message ?? "failed"}\n`);
}
