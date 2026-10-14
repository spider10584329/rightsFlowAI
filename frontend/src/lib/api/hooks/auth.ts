"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, authRequest } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import type {
  AuthSession,
  Schemas,
  LoginPayload,
  MessageResponse,
  PasswordChange,
  RegisterPayload,
  SessionPayload,
  User,
  UserProfileUpdate,
} from "@/lib/api/types";

/** Current session via the BFF (`/api/auth/session`). 401 resolves to an ApiError. */
export function useSessionQuery(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => authRequest<SessionPayload>("GET", "session", { signal }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    enabled: options.enabled ?? true,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LoginPayload) => authRequest<SessionPayload>("POST", "login", { body: payload }),
    onSuccess: (data) => {
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session, data);
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RegisterPayload) => authRequest<SessionPayload>("POST", "register", { body: payload }),
    onSuccess: (data) => {
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session, data);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authRequest<MessageResponse>("POST", "logout"),
    onSettled: () => {
      queryClient.clear();
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UserProfileUpdate) => api.patch<User>("/auth/me", { body: payload }),
    onSuccess: (user) => {
      queryClient.setQueryData<SessionPayload>(queryKeys.session, { user });
    },
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PasswordChange) => authRequest<MessageResponse>("POST", "change-password", { body: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authSessions });
    },
  });
}

export function useAuthSessions() {
  return useQuery({
    queryKey: queryKeys.authSessions,
    queryFn: ({ signal }) => api.get<AuthSession[]>("/auth/me/sessions", { signal }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.delete<MessageResponse>(`/auth/me/sessions/${encodeURIComponent(sessionId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authSessions });
    },
  });
}

/** Revokes every session on the backend, then clears this browser's cookies. */
export function useLogoutEverywhere() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post<MessageResponse>("/auth/logout-all");
      await authRequest<MessageResponse>("POST", "logout").catch(() => undefined);
    },
    onSettled: () => {
      queryClient.clear();
    },
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: () => api.post<MessageResponse>("/auth/email/resend-verification"),
  });
}

export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.post<User>("/auth/email/verify", { body: { token }, skipAuthRedirect: true }),
    onSuccess: (user) => {
      const current = queryClient.getQueryData<SessionPayload>(queryKeys.session);
      if (current && current.user.id === user.id) queryClient.setQueryData<SessionPayload>(queryKeys.session, { user });
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) =>
      api.post<MessageResponse>("/auth/password/forgot", { body: { email }, skipAuthRedirect: true }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (payload: { token: string; new_password: string }) =>
      api.post<MessageResponse>("/auth/password/reset", { body: payload, skipAuthRedirect: true }),
  });
}

export type NotificationPreferences = Schemas["NotificationPreferencesResponse"];
export type NotificationPreferencesUpdate = Schemas["NotificationPreferencesUpdate"];

/** Which notification types are also emailed to the current user. */
export function useNotificationPreferences() {
  return useQuery({
    queryKey: queryKeys.notificationPreferences,
    queryFn: ({ signal }) => api.get<NotificationPreferences>("/auth/me/notification-preferences", { signal }),
  });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPreferencesUpdate) =>
      api.put<NotificationPreferences>("/auth/me/notification-preferences", { body }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.notificationPreferences, data),
  });
}
