/**
 * Builds responses in the backend error envelope shape so the browser
 * client can parse BFF-originated errors exactly like backend errors:
 * `{ error: { code, message, details }, detail, request_id }`.
 */
export interface ErrorEnvelope {
  error: { code: string; message: string; details: unknown };
  detail: string;
  request_id: string | null;
}

export function errorEnvelope(
  code: string,
  message: string,
  details: unknown = null,
  requestId: string | null = null,
): ErrorEnvelope {
  return { error: { code, message, details }, detail: message, request_id: requestId };
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  options: { details?: unknown; requestId?: string | null; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  if (options.requestId) headers.set("x-request-id", options.requestId);
  return new Response(
    JSON.stringify(errorEnvelope(code, message, options.details ?? null, options.requestId ?? null)),
    { status, headers },
  );
}
