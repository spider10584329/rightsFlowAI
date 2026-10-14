import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { Role } from "@/lib/api/types";
import { isRole, ROLE_LABELS } from "@/lib/roles";

const ROLE_TONES: Record<Role, BadgeTone> = {
  owner: "primary",
  admin: "accent",
  manager: "info",
  viewer: "neutral",
};

export function RoleBadge({ role }: { role: string | null | undefined }) {
  if (!isRole(role)) return <Badge>{role ?? "—"}</Badge>;
  return <Badge tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Badge>;
}
