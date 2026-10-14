import type { NextRequest } from "next/server";

import {
  BACKEND_UNAVAILABLE_MESSAGE,
  guard,
  readJsonObject,
  requestIdFrom,
  signIn,
} from "@/lib/server/auth-handlers";
import { jsonError } from "@/lib/server/errors";

/** POST /api/auth/login { email, password } -> sets session cookies, returns { user }. */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request.headers);
  const blocked = guard(request, false, requestId);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password || email.length > 320 || password.length > 128) {
    return jsonError(422, "validation_failed", "Enter your email address and password", { requestId });
  }

  try {
    return await signIn(request, requestId, { email, password });
  } catch {
    return jsonError(502, "backend_unavailable", BACKEND_UNAVAILABLE_MESSAGE, { requestId });
  }
}
