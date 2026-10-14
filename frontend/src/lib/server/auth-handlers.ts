import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  backendUrl,
  clientContextHeaders,
  fetchCurrentUser,
  isTokenPair,
  requestIdFrom,
  type TokenPair,
} from "@/lib/server/backend";
import { clearSessionCookies, rotateCsrfCookie, setSessionCookies } from "@/lib/server/cookies";
import { configuredOrigins, verifyCsrf } from "@/lib/server/csrf";
import { jsonError } from "@/lib/server/errors";

export const BACKEND_UNAVAILABLE_MESSAGE = "The RightsFlow API is not reachable. Please try again shortly.";

/** Verifies origin (and optionally the CSRF token) or returns a 403 response. */
export function guard(request: NextRequest, requireToken: boolean, requestId: string): Response | null {
  const result = verifyCsrf(request, { requireToken, allowedOrigins: configuredOrigins() });
  if (result.ok) return null;
  return jsonError(403, result.code, result.message, { requestId });
}

/** Reads a JSON object body; returns null for invalid JSON. */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** Copies a backend response (status + JSON body + request id) to the browser. */
export async function relay(upstream: Response, requestId: string): Promise<NextResponse> {
  const text = await upstream.text();
  const headers = new Headers({ "cache-control": "no-store" });
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  headers.set("x-request-id", upstream.headers.get("x-request-id") ?? requestId);
  return new NextResponse(text || null, { status: upstream.status, headers });
}

export async function postBackendJson(
  path: string,
  body: unknown,
  request: NextRequest,
  requestId: string,
  accessToken?: string,
): Promise<Response> {
  const headers = clientContextHeaders(request.headers, requestId);
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return fetch(backendUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

/**
 * Exchanges credentials for tokens, loads the user and returns a response
 * that sets the session cookies and a fresh CSRF token. Shared by login and
 * register (auto sign-in).
 */
export async function signIn(
  request: NextRequest,
  requestId: string,
  credentials: { email: string; password: string },
  status = 200,
): Promise<Response> {
  const login = await postBackendJson("/api/v1/auth/login", credentials, request, requestId);
  if (!login.ok) return relay(login, requestId);

  const tokens: unknown = await login.json();
  if (!isTokenPair(tokens)) {
    return jsonError(502, "bad_gateway", "Unexpected response from the authentication service", { requestId });
  }
  return sessionResponse(request, requestId, tokens, status);
}

export async function sessionResponse(
  request: NextRequest,
  requestId: string,
  tokens: TokenPair,
  status = 200,
): Promise<Response> {
  const me = await fetchCurrentUser(tokens.access_token, request.headers, requestId);
  if (!me.ok) return relay(me, requestId);
  const user: unknown = await me.json();

  const response = NextResponse.json({ user }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
  setSessionCookies(response, tokens);
  rotateCsrfCookie(response);
  return response;
}

export function signedOutResponse(requestId: string, body: unknown = { message: "Signed out" }, status = 200) {
  const response = NextResponse.json(body, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
  clearSessionCookies(response);
  rotateCsrfCookie(response);
  return response;
}

export { requestIdFrom };
