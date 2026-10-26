import type { CommanderError } from '@commander-js/extra-typings';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BulkitError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
} from 'bulkit';

/**
 * Exit codes are part of the public interface: scripts branch on them, so a code
 * never changes meaning once released. New failure modes get new numbers.
 */
export const ExitCode = {
  Ok: 0,
  /** Anything that went wrong and has no more specific code. */
  Error: 1,
  /** The command line itself was wrong: unknown flag, missing argument, bad value. */
  Usage: 2,
  /** No API key, or the API rejected it (401) or its scope (403). */
  Auth: 3,
  /** The resource does not exist in this workspace (404). */
  NotFound: 4,
  /** The plan's allowance for this period is spent (402). Retrying will not help. */
  Quota: 5,
  /** Interrupted with Ctrl-C (128 + SIGINT). */
  Interrupted: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const ISSUES_URL = 'https://github.com/bulkit-io/bulkit-cli/issues';

/** An expected failure, with a message written for the person at the terminal. */
export class CliError extends Error {
  override name = 'CliError';
  readonly exitCode: ExitCode;
  /** What to do about it. Printed after the message. */
  readonly hint: string | undefined;

  constructor(message: string, options: { exitCode?: ExitCode; hint?: string } = {}) {
    super(message);
    this.exitCode = options.exitCode ?? ExitCode.Error;
    this.hint = options.hint;
  }
}

/** The arguments were wrong. Exits 2, like every other Unix tool. */
export class UsageError extends CliError {
  override name = 'UsageError';

  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Usage, hint });
  }
}

/**
 * Ends the command with a non-zero code after it has already said everything it
 * needs to (e.g. `posts get --wait` reporting a failed post). Prints nothing more.
 */
export class SilentExit extends Error {
  override name = 'SilentExit';
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode) {
    super(`exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

export interface ErrorReport {
  exitCode: ExitCode;
  message: string;
  hint?: string | undefined;
  /** Extra lines under the message, such as per-field validation failures. */
  details?: string[] | undefined;
  /** Machine-readable fields for `--json` output. */
  json?: Record<string, unknown> | undefined;
  /** True for bugs: the stack trace is worth showing and reporting. */
  unexpected?: boolean;
}

/** Turns anything thrown into what to print and which code to exit with. */
export function describeError(error: unknown): ErrorReport {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      message: error.message,
      hint: error.hint,
      json: { message: error.message },
    };
  }
  if (error instanceof APIError) return describeApiError(error);
  if (error instanceof APIConnectionTimeoutError) {
    return {
      exitCode: ExitCode.Error,
      message: 'The request to the Bulkit API timed out.',
      hint: 'Check your connection and try again. A write may still have gone through: look before you retry.',
      json: { message: error.message, code: 'timeout' },
    };
  }
  if (error instanceof APIConnectionError) {
    return {
      exitCode: ExitCode.Error,
      message: 'Could not reach the Bulkit API.',
      hint: 'Check your network connection, proxy settings and BULKIT_BASE_URL.',
      json: { message: error.message, code: 'connection_error' },
    };
  }
  if (error instanceof BulkitError) {
    return { exitCode: ExitCode.Error, message: error.message, json: { message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: ExitCode.Error,
    message: `Unexpected error: ${message}`,
    hint: `This is a bug in the Bulkit CLI. Re-run with --debug and report it at ${ISSUES_URL}`,
    json: { message, code: 'internal_error' },
    unexpected: true,
  };
}

function describeApiError(error: APIError): ErrorReport {
  const json = {
    message: error.message,
    status: error.status,
    code: error.code,
    field: error.field,
    details: error.details,
    requestId: error.requestId,
  };
  const details = (error.details ?? []).map((d) => `${d.field}: ${d.message}`);
  if (error.requestId) details.push(`Request ID: ${error.requestId}`);

  let exitCode: ExitCode = ExitCode.Error;
  let hint: string | undefined;
  if (error instanceof AuthenticationError) {
    exitCode = ExitCode.Auth;
    hint = 'Your API key was rejected. Run `bulkit auth login` with a valid key.';
  } else if (error instanceof PermissionDeniedError) {
    exitCode = ExitCode.Auth;
    hint = 'This API key does not have the scope for that action. Use a key with write access.';
  } else if (error instanceof NotFoundError) {
    exitCode = ExitCode.NotFound;
  } else if (error instanceof QuotaExceededError) {
    exitCode = ExitCode.Quota;
    hint = 'Run `bulkit usage` to see your limits and when the period resets.';
  } else if (error instanceof RateLimitError) {
    const wait = error.retryAfter;
    hint = wait === undefined ? 'Wait a moment and try again.' : `Try again in ${wait}s.`;
  } else if (error.status >= 500) {
    hint = 'Something went wrong on Bulkit’s side. Quote the request ID if you contact support.';
  }

  const field = error.field && !error.details?.length ? ` (${error.field})` : '';
  return { exitCode, message: `${error.message}${field}`, hint, details, json };
}

/** Commander reports its own parse errors; we only need their exit code. */
export function commanderExitCode(error: CommanderError): ExitCode {
  // Asked-for help and --version exit 0. Help shown because a subcommand was missing
  // (`bulkit posts`) carries exit code 1, and like every parse error it is a usage error.
  return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
}
