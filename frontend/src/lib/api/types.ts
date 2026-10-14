/**
 * Hand-written domain types for the auth / organization foundation.
 * They mirror `backend/app/schemas/{user,auth,organization,common}.py`.
 * The generated OpenAPI types live in `./schema.d.ts` (`npm run gen:api`);
 * `Schemas` re-exports them for modules that prefer generated shapes.
 *
 * Datetimes are ISO strings in UTC without an offset - parse them with
 * `parseApiDate` from `@/lib/utils`.
 */
import type { components } from "./schema";

export type Schemas = components["schemas"];

export type Role = "owner" | "admin" | "manager" | "viewer";
export type AssignableRole = Exclude<Role, "owner">;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface PageQuery {
  page?: number;
  page_size?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface MessageResponse {
  message: string;
}

// ----------------------------------------------------------------- users & auth

export interface User {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  created_at: string;
  email_verified: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  job_title: string | null;
  timezone: string | null;
  last_organization_id: string | null;
}

export interface SessionPayload {
  user: User;
}

export interface UserProfileUpdate {
  full_name?: string;
  job_title?: string | null;
  timezone?: string | null;
}

export interface PasswordChange {
  current_password: string;
  new_password: string;
}

export interface AuthSession {
  id: string;
  family_id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  created_ip: string | null;
  user_agent: string | null;
  is_current: boolean;
}

export interface RegisterPayload {
  email: string;
  full_name: string;
  password: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

// ----------------------------------------------------------------- organizations

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  legal_name: string | null;
  description: string | null;
  website: string | null;
  country_code: string | null;
  default_currency: string;
  timezone: string;
  brand_color: string | null;
  logo_url: string | null;
  role: Role | null;
}

export type AllocationBasis = "controlled_pro_rata" | "gross_share";

export interface OrganizationSettings {
  allocation_basis: AllocationBasis;
  require_distinct_payout_approver: boolean;
  contract_expiry_warning_days: number;
  auto_match_title_artist: boolean;
  ai_contract_analysis_enabled: boolean;
}

export interface OrganizationDetail extends Organization {
  settings: OrganizationSettings;
  member_count: number;
}

export interface OrganizationCreate {
  name: string;
  slug: string;
  default_currency?: string;
}

export interface OrganizationUpdate {
  name?: string;
  legal_name?: string | null;
  description?: string | null;
  website?: string | null;
  country_code?: string | null;
  default_currency?: string | null;
  timezone?: string | null;
  brand_color?: string | null;
  logo_url?: string | null;
}

export interface Membership {
  id: string;
  organization_id: string;
  user_id: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  user_email: string | null;
  user_full_name: string | null;
}

export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface Invitation {
  id: string;
  organization_id: string;
  email: string;
  role: AssignableRole;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
  invited_by_id: string | null;
  message: string | null;
  organization_name: string | null;
}

/** `email_delivery` is `logged` when the dev console provider wrote the email to disk instead of sending it. */
export interface InvitationCreated extends Invitation {
  invite_url: string;
  email_delivery: "sent" | "logged" | "failed" | string;
}

export interface InvitationCreate {
  email: string;
  role: AssignableRole;
  message?: string | null;
}

export interface OwnershipTransfer {
  new_owner_membership_id: string;
  password: string;
  confirm_slug: string;
}

export interface OrganizationArchive {
  password: string;
  confirm_slug: string;
}

export interface AuditChange {
  from: unknown;
  to: unknown;
}

export interface AuditLogEntry {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  changes: Record<string, AuditChange | unknown> | null;
  ip_address: string | null;
  created_at: string;
}

// ----------------------------------------------------------------- notifications
// Mirrors backend/app/schemas/notification.py.

export type NotificationSeverity = "info" | "success" | "warning" | "error" | "critical" | string;

export interface AppNotification {
  id: string;
  organization_id: string | null;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: NotificationSeverity;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPage extends Page<AppNotification> {
  unread_count: number;
}

// ----------------------------------------------------------------- reference data

export interface ReferenceItem {
  code: string;
  name: string;
}
