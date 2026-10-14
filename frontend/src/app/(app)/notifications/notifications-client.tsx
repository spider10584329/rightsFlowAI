"use client";

import { Bell, BellOff, CheckCheck, ExternalLink, Mail, MailOpen, Trash2 } from "lucide-react";
import Link from "next/link";

import { NotificationSeverityDot, safeNotificationHref, severityTone } from "@/components/notifications/notification-utils";
import { useOpenNotification } from "@/components/notifications/use-open-notification";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { IconButton } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api/errors";
import {
  isModuleUnavailable,
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotification,
  useNotifications,
} from "@/lib/api/hooks/notifications";
import type { AppNotification } from "@/lib/api/types";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { cn, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

export function NotificationsClient() {
  const { organizations } = useOrg();
  const openTarget = useOpenNotification();
  const table = useTableQueryState<"filter">({ defaultPageSize: 20, filterKeys: ["filter"] });
  const unreadOnly = table.filters.filter === "unread";
  const list = useNotifications({ page: table.page, page_size: table.pageSize, unread_only: unreadOnly });
  const markOne = useMarkNotification();
  const markAll = useMarkAllNotificationsRead();
  const remove = useDeleteNotification();

  const unavailable = isModuleUnavailable(list.error);
  const unreadCount = list.data?.unread_count ?? 0;
  const orgNames = new Map(organizations.map((org) => [org.id, org.name]));

  const onError = (title: string) => (error: unknown) => toast.error(title, { description: errorMessage(error) });

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Alerts about statements, conflicts, approvals and your team."
        meta={unreadCount > 0 ? <Badge tone="primary">{unreadCount} unread</Badge> : null}
        actions={
          !unavailable ? (
            <Button
              variant="outline"
              leftIcon={<CheckCheck aria-hidden />}
              disabled={unreadCount === 0}
              loading={markAll.isPending}
              onClick={() =>
                markAll.mutate(undefined, {
                  onSuccess: () => toast.success("All notifications marked as read"),
                  onError: onError("Could not mark all as read"),
                })
              }
            >
              Mark all as read
            </Button>
          ) : null
        }
      />
      <SegmentedControl
        aria-label="Show notifications"
        className="mb-4"
        value={unreadOnly ? "unread" : "all"}
        onValueChange={(value) => table.setFilter("filter", value === "unread" ? "unread" : null)}
        options={[
          { value: "all", label: "All" },
          {
            value: "unread",
            label: (
              <>
                Unread
                {unreadCount > 0 ? (
                  <span className="rounded-full bg-primary-soft px-1.5 text-2xs font-semibold text-primary-soft-fg tabular-nums">{unreadCount}</span>
                ) : null}
              </>
            ),
          },
        ]}
      />
      <Card>
        {unavailable ? (
          <EmptyState
            icon={<BellOff aria-hidden />}
            title="Notifications aren't available"
            description="The notifications service is not enabled on this server yet. Nothing has been lost; check back after it's deployed."
          />
        ) : list.isLoading ? (
          <ul className="divide-y divide-border" aria-label="Loading notifications">
            {Array.from({ length: 5 }, (_, index) => (
              <li key={index} className="flex gap-3 px-5 py-4">
                <Skeleton className="mt-1 size-2 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </li>
            ))}
          </ul>
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Bell aria-hidden />}
            title={unreadOnly ? "No unread notifications" : "No notifications yet"}
            description={unreadOnly ? "You're all caught up." : "Important events across your organizations will show up here."}
          />
        ) : (
          <>
            <ul className={cn("divide-y divide-border", list.isFetching && "opacity-70 transition-opacity")} aria-busy={list.isFetching}>
              {list.data?.items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  organizationName={notification.organization_id ? orgNames.get(notification.organization_id) : undefined}
                  onToggleRead={() =>
                    markOne.mutate({ id: notification.id, read: !notification.is_read }, { onError: onError("Could not update notification") })
                  }
                  onDelete={() =>
                    remove.mutate(notification.id, {
                      onSuccess: () => toast.success("Notification deleted"),
                      onError: onError("Could not delete notification"),
                    })
                  }
                  onOpen={() => void openTarget(notification)}
                />
              ))}
            </ul>
            {list.data ? (
              <div className="border-t border-border">
                <Pagination
                  page={table.page}
                  pageSize={table.pageSize}
                  total={list.data.total}
                  onPageChange={table.setPage}
                  onPageSizeChange={table.setPageSize}
                  pageSizeOptions={[10, 20, 50]}
                  disabled={list.isFetching}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}

function NotificationRow({
  notification,
  organizationName,
  onToggleRead,
  onDelete,
  onOpen,
}: {
  notification: AppNotification;
  organizationName?: string;
  onToggleRead: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const href = safeNotificationHref(notification.link);
  return (
    <li className={cn("group flex gap-3 px-5 py-4 transition-colors", !notification.is_read && "bg-primary-soft/30")}>
      <NotificationSeverityDot severity={notification.severity} className="mt-1.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("text-sm", notification.is_read ? "text-fg-muted" : "font-semibold text-fg")}>
            {notification.title}
            {!notification.is_read ? <span className="sr-only"> (unread)</span> : null}
          </p>
          {notification.severity !== "info" ? <Badge tone={severityTone(notification.severity)}>{titleCase(notification.severity)}</Badge> : null}
        </div>
        {notification.body ? <p className="text-[13px] leading-relaxed text-fg-muted">{notification.body}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          <Tooltip content={formatDateTime(notification.created_at)}>
            <time dateTime={notification.created_at} tabIndex={0} className="rounded focus-visible:outline-2 focus-visible:outline-ring">
              {formatRelative(notification.created_at)}
            </time>
          </Tooltip>
          {organizationName ? <span>{organizationName}</span> : null}
          <span>{titleCase(notification.type)}</span>
          {href ? (
            <Link
              href={href}
              onClick={(event) => {
                // Plain clicks go through onOpen (switches organization when needed);
                // modified clicks keep the browser's open-in-new-tab behaviour.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                onOpen();
              }}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Open <ExternalLink className="size-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-1">
        <IconButton
          label={notification.is_read ? "Mark as unread" : "Mark as read"}
          icon={notification.is_read ? <Mail aria-hidden /> : <MailOpen aria-hidden />}
          size="sm"
          onClick={onToggleRead}
        />
        <IconButton label="Delete notification" icon={<Trash2 aria-hidden />} size="sm" variant="danger" onClick={onDelete} />
      </div>
    </li>
  );
}
