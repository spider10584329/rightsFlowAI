"use client";

import { Bell, BellOff, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { NotificationSeverityDot, safeNotificationHref } from "@/components/notifications/notification-utils";
import { useOpenNotification } from "@/components/notifications/use-open-notification";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import {
  isModuleUnavailable,
  useMarkAllNotificationsRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/lib/api/hooks/notifications";
import type { AppNotification } from "@/lib/api/types";
import { cn, formatRelative } from "@/lib/utils";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const openTarget = useOpenNotification();
  const unread = useUnreadNotificationCount();
  const latest = useNotifications({ page: 1, page_size: 8 }, { enabled: open });
  const markAll = useMarkAllNotificationsRead();

  const unavailable = isModuleUnavailable(unread.error) || isModuleUnavailable(latest.error);
  const count = unread.data ?? 0;
  const label = unavailable ? "Notifications (unavailable)" : count > 0 ? `Notifications, ${count} unread` : "Notifications";

  const openNotification = (notification: AppNotification) => {
    if (safeNotificationHref(notification.link)) setOpen(false);
    void openTarget(notification);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Bell className="size-[18px]" aria-hidden />
          {count > 0 && !unavailable ? (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-surface tabular-nums">
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0" aria-label="Notifications">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          {!unavailable && count > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              leftIcon={<CheckCheck aria-hidden />}
              loading={markAll.isPending}
              onClick={() =>
                markAll.mutate(undefined, {
                  onError: (error) => toast.error("Could not mark notifications as read", { description: errorMessage(error) }),
                })
              }
            >
              Mark all read
            </Button>
          ) : null}
        </div>
        <div className="scrollbar-thin max-h-[26rem] overflow-y-auto">
          {unavailable ? (
            <EmptyState
              compact
              icon={<BellOff aria-hidden />}
              title="Notifications aren't available"
              description="The notifications service is not enabled on this server yet."
            />
          ) : latest.isLoading ? (
            <ul className="space-y-3 p-4" aria-label="Loading notifications">
              {Array.from({ length: 3 }, (_, index) => (
                <li key={index} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </li>
              ))}
            </ul>
          ) : latest.error ? (
            <p className="p-4 text-[13px] text-danger">{errorMessage(latest.error)}</p>
          ) : (latest.data?.items.length ?? 0) === 0 ? (
            <EmptyState compact icon={<Bell aria-hidden />} title="You're all caught up" description="New activity will appear here." />
          ) : (
            <ul className="divide-y divide-border">
              {latest.data?.items.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(notification)}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      !notification.is_read && "bg-primary-soft/35",
                    )}
                  >
                    <NotificationSeverityDot severity={notification.severity} className="mt-1.5" />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-[13px] leading-snug", notification.is_read ? "text-fg-muted" : "font-semibold text-fg")}>
                        {notification.title}
                      </span>
                      {notification.body ? (
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-muted">{notification.body}</span>
                      ) : null}
                      <span className="mt-1 block text-2xs text-fg-subtle">{formatRelative(notification.created_at)}</span>
                    </span>
                    {!notification.is_read ? <span className="sr-only">Unread</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-4 py-2.5">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="text-[13px] font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
