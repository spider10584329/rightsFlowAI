import type { NextRequest } from "next/server";

import { guard, postBackendJson, requestIdFrom, signedOutResponse } from "@/lib/server/auth-handlers";
import { readSessionCookies } from "@/lib/server/cookies";

/**
 * POST /api/auth/logout - revokes the session on the backend (best effort)
 * and always clears the session cookies. Requires the CSRF token.
 */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request.headers);
  const blocked = guard(request, true, requestId);
  if (blocked) return blocked;

  const { accessToken, refreshToken } = readSessionCookies(request);
  if (accessToken || refreshToken) {
    try {
      const upstream = await postBackendJson(
        "/api/v1/auth/logout",
        { refresh_token: refreshToken ?? null },
        request,
        requestId,
        accessToken,
      );
      await upstream.body?.cancel();
    } catch {
      // Backend unreachable: cookies are still cleared locally.
    }
  }
  return signedOutResponse(requestId);
}
