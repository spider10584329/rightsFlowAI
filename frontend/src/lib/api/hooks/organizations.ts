"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import type {
  AssignableRole,
  AuditLogEntry,
  Invitation,
  InvitationCreate,
  InvitationCreated,
  Membership,
  MessageResponse,
  Organization,
  OrganizationArchive,
  OrganizationCreate,
  OrganizationDetail,
  OrganizationSettings,
  OrganizationUpdate,
  OwnershipTransfer,
  Page,
  SessionPayload,
  User,
} from "@/lib/api/types";

const orgPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;

// ----------------------------------------------------------------- organizations

export function useOrganizations(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.organizations,
    queryFn: ({ signal }) => api.get<Organization[]>("/organizations", { signal }),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OrganizationCreate) => api.post<Organization>("/organizations", { body: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizations });
    },
  });
}

/** Persists the active organization on the user (`last_organization_id`). */
export function useSetActiveOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      api.put<User>("/auth/me/active-organization", { body: { organization_id: organizationId } }),
    onSuccess: (user) => {
      queryClient.setQueryData<SessionPayload>(queryKeys.session, { user });
    },
  });
}

export function useOrganizationDetail(orgId: string) {
  return useQuery({
    queryKey: queryKeys.orgDetail(orgId),
    queryFn: ({ signal }) => api.get<OrganizationDetail>(orgPath(orgId), { signal }),
  });
}

export function useUpdateOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OrganizationUpdate) => api.patch<OrganizationDetail>(orgPath(orgId), { body: payload }),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.orgDetail(orgId), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizations });
    },
  });
}

export function useUpdateOrganizationSettings(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OrganizationSettings) =>
      api.put<OrganizationSettings>(`${orgPath(orgId)}/settings`, { body: payload }),
    onSuccess: (settings) => {
      queryClient.setQueryData<OrganizationDetail>(queryKeys.orgDetail(orgId), (current) =>
        current ? { ...current, settings } : current,
      );
    },
  });
}

export function useArchiveOrganization(orgId: string) {
  return useMutation({
    mutationFn: (payload: OrganizationArchive) => api.post<MessageResponse>(`${orgPath(orgId)}/archive`, { body: payload }),
  });
}

export function useLeaveOrganization(orgId: string) {
  return useMutation({
    mutationFn: () => api.post<MessageResponse>(`${orgPath(orgId)}/leave`),
  });
}

export function useTransferOwnership(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OwnershipTransfer) =>
      api.post<Membership>(`${orgPath(orgId)}/transfer-ownership`, { body: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizations });
    },
  });
}

// ----------------------------------------------------------------- members

export function useMembers(orgId: string, includeInactive: boolean) {
  return useQuery({
    queryKey: queryKeys.members(orgId, includeInactive),
    queryFn: ({ signal }) =>
      api.get<Membership[]>(`${orgPath(orgId)}/members`, {
        query: { include_inactive: includeInactive || undefined },
        signal,
      }),
  });
}

function useMemberMutation<TVariables>(orgId: string, fn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org", orgId, "members"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orgDetail(orgId) });
    },
  });
}

export function useChangeMemberRole(orgId: string) {
  return useMemberMutation(orgId, ({ membershipId, role }: { membershipId: string; role: AssignableRole }) =>
    api.patch<Membership>(`${orgPath(orgId)}/members/${encodeURIComponent(membershipId)}/role`, { body: { role } }),
  );
}

export function useSetMemberActive(orgId: string) {
  return useMemberMutation(orgId, ({ membershipId, active }: { membershipId: string; active: boolean }) =>
    api.patch<Membership>(
      `${orgPath(orgId)}/members/${encodeURIComponent(membershipId)}/${active ? "reactivate" : "deactivate"}`,
    ),
  );
}

export function useRemoveMember(orgId: string) {
  return useMemberMutation(orgId, (membershipId: string) =>
    api.delete<MessageResponse>(`${orgPath(orgId)}/members/${encodeURIComponent(membershipId)}`),
  );
}

// ----------------------------------------------------------------- invitations (admin)

export function useInvitations(orgId: string, status?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.invitations(orgId, status),
    queryFn: ({ signal }) => api.get<Invitation[]>(`${orgPath(orgId)}/invitations`, { query: { status }, signal }),
    enabled: options.enabled ?? true,
  });
}

export function useCreateInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: InvitationCreate) =>
      api.post<InvitationCreated>(`${orgPath(orgId)}/invitations`, { body: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org", orgId, "invitations"] });
    },
  });
}

export function useRevokeInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.post<Invitation>(`${orgPath(orgId)}/invitations/${encodeURIComponent(invitationId)}/revoke`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org", orgId, "invitations"] });
    },
  });
}

/** Re-send a pending/expired invitation; returns a fresh one-time link (old links stop working). */
export function useResendInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.post<InvitationCreated>(`${orgPath(orgId)}/invitations/${encodeURIComponent(invitationId)}/resend`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org", orgId, "invitations"] });
    },
  });
}

// ----------------------------------------------------------------- invitations (invitee)

export function useMyInvitations(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.myInvitations,
    queryFn: ({ signal }) => api.get<Invitation[]>("/invitations/mine", { signal }),
    enabled: options.enabled ?? true,
  });
}

function useInviteeMutation<TVariables, TResult>(fn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myInvitations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizations });
    },
  });
}

export function useAcceptInvitationById() {
  return useInviteeMutation((invitationId: string) =>
    api.post<Membership>(`/invitations/${encodeURIComponent(invitationId)}/accept`),
  );
}

export function useDeclineInvitationById() {
  return useInviteeMutation((invitationId: string) =>
    api.post<Invitation>(`/invitations/${encodeURIComponent(invitationId)}/decline`),
  );
}

/** Public preview of an invitation link (no session required). */
export function useInvitationPreview(token: string) {
  return useQuery({
    queryKey: queryKeys.invitationPreview(token),
    queryFn: ({ signal }) =>
      api.post<Invitation>("/invitations/preview", { body: { token }, signal, skipAuthRedirect: true }),
    enabled: token.length >= 20,
    retry: false,
  });
}

export function useAcceptInvitationToken() {
  return useInviteeMutation((token: string) => api.post<Membership>("/invitations/accept", { body: { token } }));
}

export function useDeclineInvitationToken() {
  return useInviteeMutation((token: string) => api.post<Invitation>("/invitations/decline", { body: { token } }));
}

// ----------------------------------------------------------------- activity

export interface ActivityQuery {
  page: number;
  page_size: number;
  order: "asc" | "desc";
  action?: string;
  entity_type?: string;
  entity_id?: string;
}

export function useActivity(orgId: string, params: ActivityQuery) {
  return useQuery({
    queryKey: queryKeys.activity(orgId, { ...params }),
    queryFn: ({ signal }) =>
      api.get<Page<AuditLogEntry>>(`${orgPath(orgId)}/activity`, {
        query: { ...params, sort: "created_at" },
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}
