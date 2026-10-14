"use client";

import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { setUnauthorizedHandler } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useLogout, useSessionQuery } from "@/lib/api/hooks/auth";
import type { User } from "@/lib/api/types";
import { clientOnlyBailout, type TrackedPromise } from "@/lib/client-only";
import { useReadySignal } from "@/lib/hooks/use-ready-signal";
import { hardNavigate } from "@/lib/navigation";

export interface SessionValue {
  user: User;
  signOut: () => Promise<void>;
  isSigningOut: boolean;
  refetch: () => void;
}

interface SessionContextValue {
  /** null while the session loads (or while redirecting to login). */
  session: SessionValue | null;
  /** Resolves once `session` is available; consumers suspend on it. */
  ready: TrackedPromise;
}

const SessionContext = createContext<SessionContextValue | null>(null);

let redirecting = false;

/** Full-page navigation to the login page, remembering where the user was. */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  hardNavigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
}

/**
 * Loads the signed-in user through the BFF. Children always render (so the
 * page segments are part of the prerendered shell); components that need the
 * user call `useSession()`, which suspends until it is available.
 * Redirects to /login on 401 and installs the API client's 401 handler.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const query = useSessionQuery();
  const logout = useLogout();

  useEffect(() => {
    setUnauthorizedHandler(() => redirectToLogin());
    return () => setUnauthorizedHandler(null);
  }, []);

  const unauthorized = isApiError(query.error) && query.error.isUnauthorized;
  useEffect(() => {
    if (unauthorized) redirectToLogin();
  }, [unauthorized]);

  const { mutateAsync: logoutAsync, isPending: isSigningOut } = logout;
  const signOut = useCallback(async () => {
    try {
      await logoutAsync();
    } finally {
      redirecting = true;
      hardNavigate("/login");
    }
  }, [logoutAsync]);

  const { refetch } = query;
  const user = query.data?.user;
  const session = useMemo<SessionValue | null>(
    () => (user ? { user, signOut, isSigningOut, refetch: () => void refetch() } : null),
    [user, signOut, isSigningOut, refetch],
  );

  const ready = useReadySignal(session !== null);
  const value = useMemo(() => ({ session, ready }), [session, ready]);

  if (query.error && !unauthorized && !session) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <ErrorState
          error={query.error}
          title="We couldn't load your session"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  return <SessionContext value={value}>{children}</SessionContext>;
}

/** Non-suspending access for providers and optional UI (null while loading). */
export function useSessionState(): SessionValue | null {
  const context = use(SessionContext);
  if (!context) throw new Error("useSessionState must be used within <SessionProvider>");
  return context.session;
}

/**
 * The signed-in user. Suspends until the session has loaded, so call it
 * below a `<Suspense>` boundary. During server rendering it bails out to
 * client rendering (the boundary's fallback is prerendered instead).
 */
export function useSession(): SessionValue {
  const context = use(SessionContext);
  if (!context) throw new Error("useSession must be used within <SessionProvider>");
  if (typeof window === "undefined") throw clientOnlyBailout("useSession reads the signed-in user");
  // Always called (stable hook order): suspends while pending, sync once fulfilled.
  use(context.ready);
  if (!context.session) throw new Error("Session is not available");
  return context.session;
}
