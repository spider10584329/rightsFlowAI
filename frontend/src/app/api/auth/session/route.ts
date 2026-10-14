import { NextResponse, type NextRequest } from "next/server";

import { SESSION_HINT_COOKIE } from "@/lib/auth/constants";
import { BACKEND_UNAVAILABLE_MESSAGE, requestIdFrom } from "@/lib/server/auth-handlers";
import { fetchCurrentUser } from "@/lib/server/backend";
import { clearSessionCookies, readSessionCookies } from "@/lib/server/cookies";
import { jsonError } from "@/lib/server/errors";
import { applySessionOutcome, callWithSession } from "@/lib/server/session";

/**
 * GET /api/auth/session -> { user } or 401.
 * Rotates tokens when the access token has expired.
 */
export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request.headers);
  const { accessToken, refreshToken } = readSessionCookies(request);

  if (!accessToken && !refreshToken) {
    const response = NextResponse.json(
      { error: { code: "unauthorized", message: "Not signed in", details: null }, detail: "Not signed in", request_id: requestId },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
    // Drop a stale session hint so the proxy stops treating the visitor as signed in.
    if (request.cookies.has(SESSION_HINT_COOKIE)) clearSessionCookies(response);
    return response;
  }

  try {
    const result = await callWithSession(
      request,
      (token) =>
        token
          ? fetchCurrentUser(token, request.headers, requestId)
          : Promise.resolve(new Response(null, { status: 401 })),
      { requestId, canRetry: true },
    );
    const { upstream } = result;
    let response: NextResponse;
    if (upstream.ok) {
      const user: unknown = await upstream.json();
      response = NextResponse.json({ user }, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
    } else if (upstream.status === 401) {
      await upstream.body?.cancel();
      response = NextResponse.json(
        {
          error: { code: "unauthorized", message: "Your session has expired. Please sign in again.", details: null },
          detail: "Your session has expired. Please sign in again.",
          request_id: requestId,
        },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
      clearSessionCookies(response);
      return response;
    } else {
      const text = await upstream.text();
      response = new NextResponse(text || null, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
      });
    }
    applySessionOutcome(response, result);
    return response;
  } catch {
    return jsonError(502, "backend_unavailable", BACKEND_UNAVAILABLE_MESSAGE, { requestId });
  }
}
