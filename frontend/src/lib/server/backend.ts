import "server-only";

import { createHash } from "node:crypto";

/**
 * Server-only access to the FastAPI backend.
 *
 * `BACKEND_URL` is read at request time and never exposed to the browser.
 */
export function backendBaseUrl(): string {
  return (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
}

export function backendUrl(path: string, search = ""): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${backendBaseUrl()}${normalized}${search}`;
}

export interface TokenPair {
  access_token: string;
  token_type?: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
}

export function isTokenPair(value: unknown): value is TokenPair {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    typeof v.expires_in === "number" &&
    typeof v.refresh_token === "string" &&
    typeof v.refresh_expires_in === "number"
  );
}

const REQUEST_ID_PATTERN = /^[\x21-\x7e]{8,64}$/;

/** Reuses a well-formed incoming X-Request-ID or creates a new one. */
export function requestIdFrom(headers: Headers): string {
  const incoming = headers.get("x-request-id");
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/** Headers describing the end user that the backend records (sessions, audit). */
export function clientContextHeaders(incoming: Headers, requestId: string): Headers {
  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("accept", incoming.get("accept") ?? "application/json");
  const userAgent = incoming.get("user-agent");
  if (userAgent) headers.set("user-agent", userAgent.slice(0, 255));
  const language = incoming.get("accept-language");
  if (language) headers.set("accept-language", language);
  const clientIp = trustedClientIp(incoming);
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
}

/**
 * The end user's IP, derived only from hops appended by proxies we trust.
 *
 * Next.js passes a client-supplied `X-Forwarded-For` through unchanged, so
 * forwarding it verbatim let anyone pick their IP and bypass per-IP rate
 * limits (audit A-02). With `TRUSTED_PROXY_HOPS=N` (N reverse proxies in front
 * of Next.js, each appending the address it saw), the client is the Nth entry
 * from the right; everything further left is attacker-controlled. With 0
 * (default) no address is forwarded and the backend sees the BFF's own IP.
 */
export function trustedClientIp(incoming: Headers, hops = trustedProxyHops()): string | null {
  if (hops <= 0) return null;
  const chain = (incoming.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length < hops) return null;
  const candidate = chain[chain.length - hops];
  return /^[0-9a-fA-F:.]{2,45}$/.test(candidate) ? candidate : null;
}

function trustedProxyHops(): number {
  const parsed = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 10 ? parsed : 0;
}

/** Decodes the `exp` claim of a JWT without verifying it (freshness hint only). */
export function accessTokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (payload && typeof payload === "object" && typeof (payload as { exp?: unknown }).exp === "number") {
      return (payload as { exp: number }).exp;
    }
  } catch {
    return null;
  }
  return null;
}

export function isAccessTokenFresh(token: string | undefined, skewSeconds = 20): boolean {
  if (!token) return false;
  const exp = accessTokenExpiry(token);
  if (exp === null) return true; // Unknown format: let the backend decide.
  return exp - skewSeconds > Date.now() / 1000;
}

export type RefreshOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; status: number; invalid: boolean };

interface InflightRefresh {
  promise: Promise<RefreshOutcome>;
  expiresAt: number;
}

/**
 * Refresh tokens are single-use and the backend revokes the whole session
 * when a rotated token is replayed. Parallel browser requests that all carry
 * the same expired session must therefore share ONE refresh call. Results
 * are memoised briefly per refresh token (keyed by its SHA-256 digest).
 *
 * This is per Node.js process; multi-instance deployments need sticky
 * sessions or a shared store (see README).
 */
const inflight = new Map<string, InflightRefresh>();
// Long enough for the parallel requests of one page load; short so a stolen,
// already-rotated refresh token cannot replay the memoised pair (audit A-09).
const RESULT_TTL_MS = 5_000;

function sweep(now: number) {
  for (const [key, entry] of inflight) {
    if (entry.expiresAt < now) inflight.delete(key);
  }
}

async function performRefresh(refreshToken: string, incoming: Headers, requestId: string): Promise<RefreshOutcome> {
  const headers = clientContextHeaders(incoming, requestId);
  headers.set("content-type", "application/json");
  try {
    const response = await fetch(backendUrl("/api/v1/auth/refresh"), {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      // 401 = invalid/expired/reused refresh token; 422 = malformed token.
      const invalid = response.status === 401 || response.status === 422;
      return { ok: false, status: response.status, invalid };
    }
    const body: unknown = await response.json();
    if (!isTokenPair(body)) return { ok: false, status: 502, invalid: false };
    return { ok: true, tokens: body };
  } catch {
    return { ok: false, status: 502, invalid: false };
  }
}

export function refreshTokens(refreshToken: string, incoming: Headers, requestId: string): Promise<RefreshOutcome> {
  const now = Date.now();
  sweep(now);
  const key = createHash("sha256").update(refreshToken).digest("hex");
  const existing = inflight.get(key);
  if (existing) return existing.promise;
  const promise = performRefresh(refreshToken, incoming, requestId);
  inflight.set(key, { promise, expiresAt: now + RESULT_TTL_MS });
  promise.then((outcome) => {
    // Transient failures should not be memoised.
    if (!outcome.ok && !outcome.invalid) inflight.delete(key);
  });
  return promise;
}

/** Fetches `/api/v1/auth/me` with an access token. */
export async function fetchCurrentUser(
  accessToken: string,
  incoming: Headers,
  requestId: string,
): Promise<Response> {
  const headers = clientContextHeaders(incoming, requestId);
  headers.set("authorization", `Bearer ${accessToken}`);
  return fetch(backendUrl("/api/v1/auth/me"), { headers, cache: "no-store" });
}
