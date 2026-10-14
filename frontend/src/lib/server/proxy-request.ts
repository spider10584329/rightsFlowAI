import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { backendUrl, clientContextHeaders, requestIdFrom } from "@/lib/server/backend";
import { configuredOrigins, verifyCsrf } from "@/lib/server/csrf";
import { jsonError } from "@/lib/server/errors";
import { applySessionOutcome, callWithSession } from "@/lib/server/session";

/** Request headers forwarded to the backend (allow-list; cookies never leave the BFF). */
const FORWARDED_REQUEST_HEADERS = ["content-type", "idempotency-key", "if-none-match", "if-match"];

/** Response headers passed back to the browser (allow-list; drops hop-by-hop and set-cookie). */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-language",
  "cache-control",
  "etag",
  "last-modified",
  "retry-after",
  "x-request-id",
  "x-total-count",
];

/**
 * Headers for a proxied backend response. API responses are data, never
 * pages: they are always `nosniff` and sandboxed, so an uploaded HTML/SVG
 * file downloaded through the BFF can't run script on the app's origin
 * (audit AF-14; proxy.ts does not cover /api routes).
 */
export function proxiedResponseHeaders(upstream: Headers, requestId: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("x-request-id")) headers.set("x-request-id", requestId);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  headers.set("x-frame-options", "DENY");
  return headers;
}

/**
 * Backend auth endpoints that issue or consume tokens. They must go through
 * the dedicated `/api/auth/*` handlers so tokens never reach browser JS.
 */
const BLOCKED_PATHS = new Set([
  "v1/auth/login",
  "v1/auth/refresh",
  "v1/auth/logout",
  "v1/auth/register",
  "v1/auth/password/change",
]);

/** Bodies up to this size are buffered so the request can be retried after a token refresh. */
const MAX_BUFFERED_BODY_BYTES = 2 * 1024 * 1024;

export type PathValidation = { ok: true; path: string } | { ok: false; message: string };

/** Validates catch-all segments: must start with `v1`, no traversal or separators. */
export function validateBackendPath(segments: readonly string[]): PathValidation {
  if (segments.length < 2 || segments[0] !== "v1") {
    return { ok: false, message: "Backend paths must start with v1/" };
  }
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("..") ||
      hasControlCharacter(segment)
    ) {
      return { ok: false, message: "Invalid backend path" };
    }
  }
  return { ok: true, path: segments.map((segment) => encodeURIComponent(segment)).join("/") };
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export async function proxyToBackend(request: NextRequest, segments: readonly string[]): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  const method = request.method.toUpperCase();

  const csrf = verifyCsrf(request, { requireToken: true, allowedOrigins: configuredOrigins() });
  if (!csrf.ok) return jsonError(403, csrf.code, csrf.message, { requestId });

  const validation = validateBackendPath(segments);
  if (!validation.ok) return jsonError(400, "invalid_path", validation.message, { requestId });
  if (BLOCKED_PATHS.has(validation.path)) {
    return jsonError(404, "not_found", "Use the /api/auth endpoints for this operation", { requestId });
  }

  const target = backendUrl(`/api/${validation.path}`, request.nextUrl.search);

  const baseHeaders = clientContextHeaders(request.headers, requestId);
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) baseHeaders.set(name, value);
  }

  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  const declaredLength = Number(request.headers.get("content-length") ?? "NaN");
  const canBuffer = !hasBody || (Number.isFinite(declaredLength) && declaredLength <= MAX_BUFFERED_BODY_BYTES);
  const bufferedBody = hasBody && canBuffer ? await request.arrayBuffer() : undefined;

  let streamConsumed = false;
  const call = async (accessToken: string | undefined): Promise<Response> => {
    const headers = new Headers(baseHeaders);
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    const init: RequestInit & { duplex?: "half" } = { method, headers, cache: "no-store", redirect: "manual" };
    if (bufferedBody !== undefined) {
      init.body = bufferedBody;
    } else if (hasBody) {
      if (streamConsumed) throw new Error("Request body stream already consumed");
      streamConsumed = true;
      init.body = request.body;
      init.duplex = "half";
    }
    return fetch(target, init);
  };

  let result;
  try {
    result = await callWithSession(request, call, { requestId, canRetry: !hasBody || bufferedBody !== undefined });
  } catch {
    return jsonError(502, "backend_unavailable", "The RightsFlow API is not reachable. Please try again shortly.", {
      requestId,
    });
  }

  const { upstream } = result;
  const headers = proxiedResponseHeaders(upstream.headers, requestId);

  const nullBody = upstream.status === 204 || upstream.status === 304 || method === "HEAD";
  const response = new NextResponse(nullBody ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
  applySessionOutcome(response, result);
  return response;
}
