import { STATUS_CODES } from "node:http";

/**
 * An error whose message is written for the person using the app and is safe to
 * send to the browser. Anything that is not an `AppError` is treated as
 * unexpected: its detail goes to the server log and the client gets a generic
 * message plus a request ID to quote.
 *
 * Never put stack traces, file paths, SQL, or text copied from an upstream
 * response in `message`. Use `detail` for that: it is logged and never sent.
 */
export class AppError extends Error {
  /** HTTP status the error maps to. Subclasses may override it. */
  statusCode: number;
  /** A short machine-readable code the client can branch on. */
  readonly code: string;
  /** Extra context for the server log only. Never sent to the client. */
  readonly detail: string | undefined;

  constructor(message: string, statusCode = 400, options: { code?: string; detail?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = options.code ?? defaultCode(statusCode);
    this.detail = options.detail;
  }
}

function defaultCode(statusCode: number): string {
  switch (statusCode) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 423: return "locked";
    case 429: return "rate_limited";
    default: return statusCode >= 500 ? "internal_error" : "request_failed";
  }
}

/** A request the user can fix: the input is wrong, or a precondition is not met. */
export class AdmissionError extends AppError {
  constructor(message: string, options: { code?: string; detail?: string; cause?: unknown } = {}) {
    super(message, 400, options);
  }
}

/** The request conflicts with current state, such as a path migration that is not ready to start. */
export class ConflictError extends AppError {
  constructor(message: string, options: { code?: string; detail?: string; cause?: unknown } = {}) {
    super(message, 409, options);
  }
}

export interface ClientError {
  statusCode: number;
  /** Safe to send to the browser. */
  message: string;
  code: string;
  /** True when this error is expected and not worth an error-level log line. */
  expected: boolean;
}

export const genericServerMessage = "Something went wrong on the server.";

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const { statusCode } = error as { statusCode: unknown };
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : undefined;
}

function fastifyCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/**
 * Decides what a client may see for any thrown value. Only `AppError`s and
 * Fastify's own request errors (bad JSON, body too large, ...) keep their
 * message; everything else, including database and filesystem errors, becomes
 * a generic message for its status class.
 */
export function toClientError(error: unknown): ClientError {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, message: error.message, code: error.code, expected: error.statusCode < 500 };
  }
  const statusCode = statusOf(error);
  if (statusCode !== undefined && statusCode < 500) {
    const code = fastifyCode(error);
    // Fastify's own errors are written without request data or internals.
    if (code?.startsWith("FST_") && error instanceof Error) {
      return { statusCode, message: error.message, code: code.toLowerCase(), expected: true };
    }
    if (statusCode === 429) return { statusCode, message: "Too many requests. Try again shortly.", code: "rate_limited", expected: true };
    return { statusCode, message: STATUS_CODES[statusCode] ?? "Request failed", code: defaultCode(statusCode), expected: true };
  }
  return { statusCode: 500, message: genericServerMessage, code: "internal_error", expected: false };
}

/**
 * The message to show for a failure that is recorded in the database or sent in
 * a normal response, such as a connection-test result. Unexpected errors yield
 * the fallback so database or filesystem detail never reaches the browser.
 */
export function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}
