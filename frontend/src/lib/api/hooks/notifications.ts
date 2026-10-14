"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/query-keys";
import type { AppNotification, MessageResponse, NotificationPage } from "@/lib/api/types";

/**
 * The notifications backend module is deployed independently. If it is not
 * mounted, its endpoints answer 404 / 405; callers use `isModuleUnavailable`
 * to render a calm "not available" state instead of an error.
 */
export function isModuleUnavailable(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 405 || error.status === 501);
}

const noRetryOnMissing = (failureCount: number, error: unknown) =>
  !isModuleUnavailable(error) && !(isApiError(error) && error.status < 500) && failureCount < 2;

/** Accepts `{count}`, `{unread_count}`, `{unread}` or a bare number. */
export function parseUnreadCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["count", "unread_count", "unread"]) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
  }
  return 0;
}

export function useUnreadNotificationCount(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: async ({ signal }) => parseUnreadCount(await api.get<unknown>("/notifications/unread-count", { signal })),
    retry: noRetryOnMissing,
    refetchInterval: (query) => (isModuleUnavailable(query.state.error) ? false : 60_000),
    refetchOnWindowFocus: true,
    enabled: options.enabled ?? true,
  });
}

export interface NotificationQuery {
  page: number;
  page_size: number;
  unread_only?: boolean;
}

export function useNotifications(params: NotificationQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.notificationList({ ...params }),
    queryFn: ({ signal }) =>
      api.get<NotificationPage>("/notifications", {
        query: { page: params.page, page_size: params.page_size, unread_only: params.unread_only || undefined },
        signal,
      }),
    retry: noRetryOnMissing,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

function useNotificationMutation<TVariables>(fn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  });
}

export function useMarkNotification() {
  return useNotificationMutation(({ id, read }: { id: string; read: boolean }) =>
    api.post<AppNotification | MessageResponse>(`/notifications/${encodeURIComponent(id)}/${read ? "read" : "unread"}`),
  );
}

export function useMarkAllNotificationsRead() {
  return useNotificationMutation(() => api.post<MessageResponse>("/notifications/read-all"));
}

export function useDeleteNotification() {
  return useNotificationMutation((id: string) => api.delete<MessageResponse>(`/notifications/${encodeURIComponent(id)}`));
}
