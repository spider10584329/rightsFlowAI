/**
 * Typed representation of the backend error envelope:
 * `{ error: { code, message, details }, detail, request_id }`.
 */
export interface ValidationIssue {
  loc: string[];
  message: string;
  type: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(init: { status: number; code: string; message: string; details?: unknown; requestId?: string | null }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? null;
    this.requestId = init.requestId ?? null;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isValidation() {
    return this.status === 422;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The request could not be processed.",
  401: "Your session has expired. Please sign in again.",
  402: "Your plan limit has been reached.",
  403: "You do not have permission to do that.",
  404: "The requested resource was not found.",
  409: "This conflicts with the current state of the resource.",
  413: "The upload is too large.",
  422: "Some fields are invalid.",
  429: "Too many requests. Please wait a moment and try again.",
  500: "Something went wrong on our side.",
  502: "The service is temporarily unreachable.",
  503: "The service is temporarily unavailable.",
};

function defaultCode(status: number): string {
  if (status === 0) return "network_error";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "error";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Builds an ApiError from a status code and a (possibly non-JSON) body.
 * Handles the RightsFlow envelope, FastAPI's plain `{detail}` shape and
 * arbitrary text.
 */
export function parseApiError(status: number, body: unknown, requestIdHeader: string | null = null): ApiError {
  const root = asRecord(body);
  const envelope = asRecord(root?.error);
  let code = defaultCode(status);
  let message = STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : "Request failed.");
  let details: unknown = null;

  if (envelope) {
    if (typeof envelope.code === "string" && envelope.code) code = envelope.code;
    if (typeof envelope.message === "string" && envelope.message) message = envelope.message;
    details = envelope.details ?? null;
  } else if (root) {
    if (typeof root.detail === "string" && root.detail) message = root.detail;
    else if (Array.isArray(root.detail)) details = root.detail;
    if (typeof root.code === "string") code = root.code;
  } else if (typeof body === "string" && body.trim() && body.length < 300 && !body.trim().startsWith("<")) {
    message = body.trim();
  }

  const requestId =
    (root && typeof root.request_id === "string" && root.request_id) || requestIdHeader || null;

  return new ApiError({ status, code, message, details, requestId });
}

/** Extracts `[{loc, message, type}]` validation issues from a 422 error. */
export function validationIssues(error: unknown): ValidationIssue[] {
  if (!isApiError(error) || !Array.isArray(error.details)) return [];
  const issues: ValidationIssue[] = [];
  for (const item of error.details) {
    const record = asRecord(item);
    if (!record) continue;
    const loc = Array.isArray(record.loc) ? record.loc.map((part) => String(part)) : [];
    const message = typeof record.message === "string" ? record.message : typeof record.msg === "string" ? record.msg : "Invalid value";
    issues.push({ loc, message: cleanValidationMessage(message), type: typeof record.type === "string" ? record.type : "value_error" });
  }
  return issues;
}

function cleanValidationMessage(message: string): string {
  return message.replace(/^Value error,\s*/i, "");
}

/** Maps validation issues to `{ fieldName: message }` using the last `loc` segment. */
export function fieldErrors(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of validationIssues(error)) {
    const field = issue.loc.length > 0 ? issue.loc[issue.loc.length - 1] : "";
    if (field && field !== "body" && !(field in result)) result[field] = issue.message;
  }
  return result;
}

/** Human readable message for any thrown value. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (isApiError(error)) {
    if (error.isValidation) {
      const issues = validationIssues(error);
      if (issues.length === 1) return issues[0].message;
    }
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
