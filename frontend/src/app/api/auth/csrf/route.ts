import { NextResponse, type NextRequest } from "next/server";

import { CSRF_COOKIE } from "@/lib/auth/constants";
import { rotateCsrfCookie } from "@/lib/server/cookies";

/**
 * GET /api/auth/csrf - ensures the double-submit CSRF cookie exists.
 * The proxy normally issues it on page loads; the client calls this only
 * when the cookie is missing (e.g. cleared by the user).
 */
export async function GET(request: NextRequest) {
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  if (!request.cookies.get(CSRF_COOKIE)?.value) rotateCsrfCookie(response);
  return response;
}
