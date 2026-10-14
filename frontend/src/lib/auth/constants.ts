/**
 * Cookie names shared by the proxy, the BFF route handlers and the browser
 * API client. Only `rf_csrf` is readable from JavaScript.
 */
export const ACCESS_COOKIE = "rf_at";
export const REFRESH_COOKIE = "rf_rt";
/** httpOnly marker (path=/) telling the proxy a refreshable session exists,
 * because `rf_rt` is scoped to `/api` and is not sent with page requests. */
export const SESSION_HINT_COOKIE = "rf_session";
export const CSRF_COOKIE = "rf_csrf";
export const CSRF_HEADER = "x-csrf-token";

export const REFRESH_COOKIE_PATH = "/api";

/** Routes that require a signed-in user (optimistic check in the proxy). */
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/catalog",
  "/rights",
  "/contracts",
  "/royalties",
  "/payouts",
  "/ai",
  "/settings",
  "/notifications",
  "/onboarding",
] as const;

/** Auth pages that a signed-in user should skip. */
export const GUEST_ONLY_PATHS = ["/login", "/register"] as const;

export const DEFAULT_AUTHENTICATED_PATH = "/dashboard";

/**
 * Returns a safe in-app path for post-login redirects, rejecting absolute
 * URLs, protocol-relative URLs and backslash tricks (open-redirect guard).
 */
export function safeNextPath(next: string | null | undefined, fallback: string = DEFAULT_AUTHENTICATED_PATH): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  for (const ch of next) {
    if (ch === "\\" || ch.charCodeAt(0) < 0x20) return fallback;
  }
  if (next.startsWith("/api/")) return fallback;
  return next;
}
