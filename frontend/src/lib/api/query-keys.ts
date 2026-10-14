/**
 * Query key factory. Organization-scoped data MUST live under
 * `["org", orgId, ...]` so switching organizations can drop it in one call.
 */
export const queryKeys = {
  session: ["session"] as const,
  organizations: ["organizations"] as const,
  myInvitations: ["invitations", "mine"] as const,
  invitationPreview: (token: string) => ["invitations", "preview", token] as const,
  authSessions: ["auth", "sessions"] as const,
  notificationPreferences: ["auth", "notification-preferences"] as const,

  org: (orgId: string) => ["org", orgId] as const,
  orgDetail: (orgId: string) => ["org", orgId, "detail"] as const,
  orgSettings: (orgId: string) => ["org", orgId, "settings"] as const,
  members: (orgId: string, includeInactive: boolean) => ["org", orgId, "members", { includeInactive }] as const,
  invitations: (orgId: string, status?: string) => ["org", orgId, "invitations", { status: status ?? null }] as const,
  activity: (orgId: string, params: Record<string, unknown>) => ["org", orgId, "activity", params] as const,
  /** Root of the workflow-automation (n8n) admin data; sub-keys live in `hooks/automation.ts`. */
  automation: (orgId: string) => ["org", orgId, "automation"] as const,

  notifications: ["notifications"] as const,
  notificationList: (params: Record<string, unknown>) => ["notifications", "list", params] as const,
  notificationUnreadCount: ["notifications", "unread-count"] as const,
};

/** Keys that survive an organization switch (user-scoped, not tenant-scoped). */
export const USER_SCOPED_ROOTS = new Set<string>(["session", "organizations", "invitations", "auth"]);
