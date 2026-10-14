import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  SESSION_HINT_COOKIE,
} from "@/lib/auth/constants";
import { generateCsrfToken } from "@/lib/auth/csrf-token";
import type { TokenPair } from "@/lib/server/backend";

export function cookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV === "production";
}

export interface SessionCookies {
  accessToken?: string;
  refreshToken?: string;
}

export function readSessionCookies(request: NextRequest): SessionCookies {
  return {
    accessToken: request.cookies.get(ACCESS_COOKIE)?.value || undefined,
    refreshToken: request.cookies.get(REFRESH_COOKIE)?.value || undefined,
  };
}

/** Writes the token cookies. Tokens are httpOnly and never readable by JS. */
export function setSessionCookies(response: NextResponse, tokens: TokenPair): void {
  const secure = cookieSecure();
  response.cookies.set({
    name: ACCESS_COOKIE,
    value: tokens.access_token,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.max(0, Math.floor(tokens.expires_in)),
  });
  response.cookies.set({
    name: REFRESH_COOKIE,
    value: tokens.refresh_token,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, Math.floor(tokens.refresh_expires_in)),
  });
  response.cookies.set({
    name: SESSION_HINT_COOKIE,
    value: "1",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.max(0, Math.floor(tokens.refresh_expires_in)),
  });
}

export function clearSessionCookies(response: NextResponse): void {
  const secure = cookieSecure();
  const expired = { value: "", httpOnly: true, sameSite: "lax" as const, secure, maxAge: 0 };
  response.cookies.set({ name: ACCESS_COOKIE, path: "/", ...expired });
  response.cookies.set({ name: REFRESH_COOKIE, path: REFRESH_COOKIE_PATH, ...expired });
  response.cookies.set({ name: SESSION_HINT_COOKIE, path: "/", ...expired });
}

/** Issues a fresh double-submit CSRF token (readable by JS by design). */
export function rotateCsrfCookie(response: NextResponse): string {
  const token = generateCsrfToken();
  response.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return token;
}
