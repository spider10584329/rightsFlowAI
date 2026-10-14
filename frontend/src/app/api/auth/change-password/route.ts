import { NextResponse, type NextRequest } from "next/server";

import {
  BACKEND_UNAVAILABLE_MESSAGE,
  guard,
  postBackendJson,
  readJsonObject,
  relay,
  requestIdFrom,
} from "@/lib/server/auth-handlers";
import { isTokenPair } from "@/lib/server/backend";
import { setSessionCookies } from "@/lib/server/cookies";
import { jsonError } from "@/lib/server/errors";
import { applySessionOutcome, callWithSession } from "@/lib/server/session";

/**
 * POST /api/auth/change-password { current_password, new_password }
 * The backend revokes all other sessions and issues a new token pair, which
 * is written to the cookies here so this browser stays signed in.
 */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request.headers);
  const blocked = guard(request, true, requestId);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  const payload = {
    current_password: typeof body?.current_password === "string" ? body.current_password : "",
    new_password: typeof body?.new_password === "string" ? body.new_password : "",
  };

  try {
    const result = await callWithSession(
      request,
      (token) => postBackendJson("/api/v1/auth/password/change", payload, request, requestId, token),
      { requestId, canRetry: true },
    );
    const { upstream } = result;
    if (!upstream.ok) {
      const response = await relay(upstream, requestId);
      applySessionOutcome(response, result);
      return response;
    }
    const tokens: unknown = await upstream.json();
    if (!isTokenPair(tokens)) {
      return jsonError(502, "bad_gateway", "Unexpected response from the authentication service", { requestId });
    }
    const response = NextResponse.json(
      { message: "Password updated. Other sessions were signed out." },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
    setSessionCookies(response, tokens);
    return response;
  } catch {
    return jsonError(502, "backend_unavailable", BACKEND_UNAVAILABLE_MESSAGE, { requestId });
  }
}
