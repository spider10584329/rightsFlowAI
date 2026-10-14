import type { Role } from "@/lib/api/types";

/** Mirrors `ROLE_RANK` in backend/app/core/permissions.py. */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, manager: 2, admin: 3, owner: 4 };

export const ROLES: Role[] = ["owner", "admin", "manager", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control including billing, ownership transfer and archiving.",
  admin: "Manage members, settings, deletions, ledger postings and payout approvals.",
  manager: "Create and edit catalog, rights, contracts and statements; run AI.",
  viewer: "Read-only access to organization data.",
};

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "admin" || value === "manager" || value === "viewer";
}

/** True when `role` meets or exceeds `minimum`. */
export function hasRole(role: Role | null | undefined, minimum: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
