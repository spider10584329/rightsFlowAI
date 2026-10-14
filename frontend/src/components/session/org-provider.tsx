"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useSessionState } from "@/components/session/session-provider";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useOrganizations, useSetActiveOrganization } from "@/lib/api/hooks/organizations";
import { USER_SCOPED_ROOTS } from "@/lib/api/query-keys";
import type { Organization, Role } from "@/lib/api/types";
import { clientOnlyBailout, type TrackedPromise } from "@/lib/client-only";
import { useReadySignal } from "@/lib/hooks/use-ready-signal";
import { hasRole, isRole } from "@/lib/roles";

export interface ActiveOrganization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  defaultCurrency: string;
  timezone: string;
}

export interface OrgValue {
  org: ActiveOrganization;
  organizations: Organization[];
  /** True when the user's role in the active organization is at least `minimum`. */
  can: (minimum: Role) => boolean;
  /** Resolves true once `organizationId` is active (also when it already was). */
  switchOrganization: (organizationId: string) => Promise<boolean>;
  isSwitching: boolean;
}

interface OrgContextValue {
  value: OrgValue | null;
  ready: TrackedPromise;
}

const OrgContext = createContext<OrgContextValue | null>(null);

function toActive(org: Organization): ActiveOrganization {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: isRole(org.role) ? org.role : "viewer",
    defaultCurrency: org.default_currency,
    timezone: org.timezone,
  };
}

/**
 * Resolves the active organization: the one picked in this tab, else the
 * user's `last_organization_id` if still a member, else the first one.
 * Users without any organization are sent to /onboarding. Children always
 * render; `useOrg()` suspends until the organization is known.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const session = useSessionState();
  const router = useRouter();
  const queryClient = useQueryClient();
  const organizations = useOrganizations({ enabled: session !== null });
  const setActive = useSetActiveOrganization();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const lastOrganizationId = session?.user.last_organization_id ?? null;
  const list = useMemo(() => organizations.data ?? [], [organizations.data]);
  const active = useMemo(
    () => list.find((org) => org.id === selectedId) ?? list.find((org) => org.id === lastOrganizationId) ?? list[0] ?? null,
    [list, selectedId, lastOrganizationId],
  );

  const noOrganizations = organizations.isSuccess && list.length === 0;
  useEffect(() => {
    if (noOrganizations) router.replace("/onboarding");
  }, [noOrganizations, router]);

  const { mutateAsync: setActiveAsync, isPending: isSwitching } = setActive;
  const activeId = active?.id;
  const switchOrganization = useCallback(
    async (organizationId: string) => {
      const target = list.find((org) => org.id === organizationId);
      if (!target) return false;
      if (target.id === activeId) return true;
      try {
        await setActiveAsync(organizationId);
        // Drop every tenant-scoped query so no data from the previous org lingers.
        queryClient.removeQueries({ predicate: (query) => !USER_SCOPED_ROOTS.has(String(query.queryKey[0])) });
        setSelectedId(organizationId);
        toast.success(`Switched to ${target.name}`);
        return true;
      } catch (error) {
        toast.error("Could not switch organization", { description: errorMessage(error) });
        return false;
      }
    },
    [list, activeId, setActiveAsync, queryClient],
  );

  const value = useMemo<OrgValue | null>(() => {
    if (!active) return null;
    const current = toActive(active);
    return {
      org: current,
      organizations: list,
      can: (minimum: Role) => hasRole(current.role, minimum),
      switchOrganization,
      isSwitching,
    };
  }, [active, list, switchOrganization, isSwitching]);

  const ready = useReadySignal(value !== null);
  const context = useMemo(() => ({ value, ready }), [value, ready]);

  if (organizations.error && !value) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <ErrorState
          error={organizations.error}
          title="We couldn't load your organizations"
          onRetry={() => void organizations.refetch()}
          retrying={organizations.isFetching}
        />
      </div>
    );
  }
  return <OrgContext value={context}>{children}</OrgContext>;
}

/**
 * The active organization and role helpers. Suspends until it is known, so
 * call it below a `<Suspense>` boundary; bails out to client rendering on
 * the server.
 */
export function useOrg(): OrgValue {
  const context = use(OrgContext);
  if (!context) throw new Error("useOrg must be used within <OrgProvider>");
  if (typeof window === "undefined") throw clientOnlyBailout("useOrg reads the active organization");
  // Always called (stable hook order): suspends while pending, sync once fulfilled.
  use(context.ready);
  if (!context.value) throw new Error("Organization is not available");
  return context.value;
}

/** Non-suspending variant for chrome that renders before the org is known. */
export function useOrgState(): OrgValue | null {
  const context = use(OrgContext);
  if (!context) throw new Error("useOrgState must be used within <OrgProvider>");
  return context.value;
}
