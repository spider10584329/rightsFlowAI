import { NextResponse, type NextRequest } from "next/server";

import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  DEFAULT_AUTHENTICATED_PATH,
  GUEST_ONLY_PATHS,
  PROTECTED_PREFIXES,
  REFRESH_COOKIE,
  SESSION_HINT_COOKIE,
  safeNextPath,
} from "@/lib/auth/constants";
import { generateCsrfToken } from "@/lib/auth/csrf-token";

/**
 * Optimistic routing only: cookie presence decides redirects. Real
 * authentication happens in the BFF route handlers and the backend.
 * Also sets security headers and issues the double-submit CSRF cookie.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession =
    request.cookies.has(ACCESS_COOKIE) || request.cookies.has(SESSION_HINT_COOKIE) || request.cookies.has(REFRESH_COOKIE);

  let response: NextResponse;
  if (!hasSession && isProtected(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    response = NextResponse.redirect(url);
  } else if (hasSession && (GUEST_ONLY_PATHS as readonly string[]).includes(pathname)) {
    const url = request.nextUrl.clone();
    const target = safeNextPath(request.nextUrl.searchParams.get("next"), DEFAULT_AUTHENTICATED_PATH);
    const [targetPath, targetQuery = ""] = target.split("?");
    url.pathname = targetPath;
    url.search = targetQuery ? `?${targetQuery}` : "";
    response = NextResponse.redirect(url);
  } else {
    response = NextResponse.next();
  }

  applySecurityHeaders(response);

  if (!request.cookies.get(CSRF_COOKIE)?.value) {
    response.cookies.set({
      name: CSRF_COOKIE,
      value: generateCsrfToken(),
      httpOnly: false,
      sameSite: "lax",
      secure: servedOverHttps(),
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return response;
}

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    // Next.js streams inline bootstrap scripts and the theme script runs
    // inline; static shells cannot carry per-request nonces.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function applySecurityHeaders(response: NextResponse) {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy());
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // Only when the site is served over HTTPS (same switch as Secure cookies):
  // HSTS on a plain-http dev host would pin browsers to https (audit A-10).
  if (servedOverHttps()) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function servedOverHttps(): boolean {
  return process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";
}

export const config = {
  matcher: [
    // Everything except API routes, Next internals and files with an extension.
    "/((?!api/|_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
