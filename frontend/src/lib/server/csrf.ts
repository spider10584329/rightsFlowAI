/**
 * CSRF and same-origin checks for the BFF route handlers.
 *
 * Defence in depth for cookie-authenticated, state-changing requests:
 *  1. Origin check - the `Origin` header must match the request host (or an
 *     explicitly configured public origin). A missing Origin is accepted only
 *     when the browser asserts `Sec-Fetch-Site: same-origin`.
 *  2. Double-submit token - the `x-csrf-token` header must equal the
 *     `rf_csrf` cookie (compared in constant time).
 *
 * The functions are pure (no Next.js imports) so they are unit-testable.
 */
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/auth/constants";

export type CsrfResult = { ok: true } | { ok: false; code: string; message: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** Constant-time string comparison (length leak only). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Reads one cookie value from a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) {
      const raw = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

export interface OriginOptions {
  /** Extra allowed origins, e.g. the public URL when behind a proxy that rewrites Host. */
  allowedOrigins?: readonly string[];
}

export function checkSameOrigin(headers: Headers, options: OriginOptions = {}): CsrfResult {
  const origin = headers.get("origin");
  const host = headers.get("host");

  if (!origin) {
    if (headers.get("sec-fetch-site") === "same-origin") return { ok: true };
    return { ok: false, code: "origin_missing", message: "Missing Origin header" };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: "origin_mismatch", message: "Cross-origin request rejected" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "origin_mismatch", message: "Cross-origin request rejected" };
  }

  if (host && parsed.host.toLowerCase() === host.toLowerCase()) return { ok: true };

  const allowed = (options.allowedOrigins ?? []).map((value) => value.replace(/\/+$/, "").toLowerCase());
  if (allowed.includes(parsed.origin.toLowerCase())) return { ok: true };

  return { ok: false, code: "origin_mismatch", message: "Cross-origin request rejected" };
}

export function checkCsrfToken(headers: Headers): CsrfResult {
  const cookieToken = readCookie(headers.get("cookie"), CSRF_COOKIE);
  const headerToken = headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken) {
    return { ok: false, code: "csrf_missing", message: "Missing CSRF token" };
  }
  if (!constantTimeEqual(cookieToken, headerToken)) {
    return { ok: false, code: "csrf_invalid", message: "Invalid CSRF token" };
  }
  return { ok: true };
}

export interface CsrfCheckOptions extends OriginOptions {
  /** Require the double-submit token (false only for login/register). */
  requireToken: boolean;
}

/**
 * Full check for a request. Safe methods pass; unsafe methods must satisfy
 * the origin check and, when `requireToken`, the double-submit token.
 */
export function verifyCsrf(
  request: { method: string; headers: Headers },
  options: CsrfCheckOptions,
): CsrfResult {
  if (isSafeMethod(request.method)) return { ok: true };
  const origin = checkSameOrigin(request.headers, options);
  if (!origin.ok) return origin;
  if (options.requireToken) return checkCsrfToken(request.headers);
  return { ok: true };
}

/** Allowed extra origins from `APP_ORIGIN` (comma separated). */
export function configuredOrigins(): string[] {
  const raw = process.env.APP_ORIGIN ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
