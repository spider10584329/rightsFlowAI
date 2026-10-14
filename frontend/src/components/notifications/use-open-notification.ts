"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { safeNotificationHref } from "@/components/notifications/notification-utils";
import { useOrg } from "@/components/session/org-provider";
import { toast } from "@/components/ui/toaster";
import { useMarkNotification } from "@/lib/api/hooks/notifications";
import type { AppNotification } from "@/lib/api/types";

/**
 * Marks a notification read and opens its link in the organization it
 * belongs to. Links are organization-relative ("/royalties/runs/…"), so a
 * notification from another organization must switch first, or the page
 * would load (or 404) in the wrong tenant (audit UI-02).
 */
export function useOpenNotification() {
  const router = useRouter();
  const { org, organizations, switchOrganization } = useOrg();
  const { mutate: markRead } = useMarkNotification();

  return useCallback(
    async (notification: AppNotification) => {
      if (!notification.is_read) markRead({ id: notification.id, read: true });
      const href = safeNotificationHref(notification.link);
      if (!href) return;
      const target = notification.organization_id;
      if (target && target !== org.id && !isUserScopedPath(href)) {
        if (!organizations.some((item) => item.id === target)) {
          toast.error("You no longer have access to that organization");
          return;
        }
        if (!(await switchOrganization(target))) return;
      }
      router.push(href);
    },
    [markRead, org.id, organizations, switchOrganization, router],
  );
}

// Pages that belong to the user, not to an organization (e.g. an invitation
// from an organization the user hasn't joined yet links to /onboarding).
const USER_SCOPED_PATHS = ["/onboarding", "/notifications", "/settings/profile"];

function isUserScopedPath(href: string): boolean {
  const path = href.split(/[?#]/)[0];
  return USER_SCOPED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
