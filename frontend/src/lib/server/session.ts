import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { isAccessTokenFresh, refreshTokens, type TokenPair } from "@/lib/server/backend";
import { clearSessionCookies, readSessionCookies, setSessionCookies } from "@/lib/server/cookies";
import { jsonError } from "@/lib/server/errors";

export interface SessionCallResult {
  upstream: Response;
  /** New tokens issued during this request; must be written to cookies. */
  tokens?: TokenPair;
  /** The session is unrecoverable; cookies must be cleared. */
  clearSession: boolean;
}

interface SessionCallOptions {
  requestId: string;
  /** Whether the upstream call can be repeated (its body is replayable). */
  canRetry: boolean;
}

/**
 * Runs `call` with the caller's access token, transparently rotating tokens:
 *  - proactively when the access cookie is missing or about to expire;
 *  - reactively, once, when the backend answers 401 and the call is replayable.
 */
export async function callWithSession(
  request: NextRequest,
  call: (accessToken: string | undefined) => Promise<Response>,
  options: SessionCallOptions,
): Promise<SessionCallResult> {
  const { accessToken, refreshToken } = readSessionCookies(request);
  let access = accessToken;
  let tokens: TokenPair | undefined;

  if (refreshToken && !isAccessTokenFresh(access)) {
    const outcome = await refreshTokens(refreshToken, request.headers, options.requestId);
    if (outcome.ok) {
      tokens = outcome.tokens;
      access = tokens.access_token;
    } else if (outcome.invalid) {
      return { upstream: unauthorized(), clearSession: true };
    }
  }

  let upstream = await call(access);

  if (upstream.status === 401 && refreshToken && !tokens && options.canRetry) {
    const outcome = await refreshTokens(refreshToken, request.headers, options.requestId);
    if (outcome.ok) {
      tokens = outcome.tokens;
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await call(tokens.access_token);
    } else if (outcome.invalid) {
      return { upstream, clearSession: true };
    }
  }

  // A 401 with freshly issued credentials (or with no refresh token at all)
  // means the session is gone: user deactivated, password changed, revoked.
  const clearSession =
    upstream.status === 401 && Boolean(accessToken || refreshToken) && (tokens !== undefined || !refreshToken);
  return { upstream, tokens: clearSession ? undefined : tokens, clearSession };
}

export function applySessionOutcome(response: NextResponse, result: Pick<SessionCallResult, "tokens" | "clearSession">) {
  if (result.clearSession) clearSessionCookies(response);
  else if (result.tokens) setSessionCookies(response, result.tokens);
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Your session has expired. Please sign in again.");
}
