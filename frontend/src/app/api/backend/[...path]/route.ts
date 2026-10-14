import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/server/proxy-request";

/**
 * Generic BFF proxy: `/api/backend/v1/...` -> `${BACKEND_URL}/api/v1/...`.
 * Adds the bearer token from the httpOnly cookie, enforces CSRF for unsafe
 * methods and rotates tokens transparently. See README "BFF".
 */
async function handler(request: NextRequest, ctx: RouteContext<"/api/backend/[...path]">) {
  const { path } = await ctx.params;
  return proxyToBackend(request, path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
