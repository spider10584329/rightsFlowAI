import type { NextRequest } from "next/server";

import {
  BACKEND_UNAVAILABLE_MESSAGE,
  guard,
  postBackendJson,
  readJsonObject,
  relay,
  requestIdFrom,
  signIn,
} from "@/lib/server/auth-handlers";
import { jsonError } from "@/lib/server/errors";

/**
 * POST /api/auth/register { email, full_name, password }
 * Creates the account (backend sends the verification email) and signs the
 * user in, returning { user } with session cookies set.
 */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request.headers);
  const blocked = guard(request, false, requestId);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  if (!body) return jsonError(422, "validation_failed", "Invalid request body", { requestId });
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const fullName = typeof body.full_name === "string" ? body.full_name : "";
  const password = typeof body.password === "string" ? body.password : "";

  try {
    const created = await postBackendJson(
      "/api/v1/auth/register",
      { email, full_name: fullName, password },
      request,
      requestId,
    );
    if (!created.ok) return relay(created, requestId);
    await created.body?.cancel();
    return await signIn(request, requestId, { email, password }, 201);
  } catch {
    return jsonError(502, "backend_unavailable", BACKEND_UNAVAILABLE_MESSAGE, { requestId });
  }
}
