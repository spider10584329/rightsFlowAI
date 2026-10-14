import { AlertOctagon, AlertTriangle, CircleDot, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { titleCase } from "@/lib/utils";

import {
  conflictStatusTone,
  conflictTypeLabel,
  rightsTypeLabel,
  severityTone,
  shareStatusTone,
  TOTAL_STATUS_LABELS,
  totalStatusTone,
  verificationTone,
  type TotalStatus,
} from "./rights-format";

const SEVERITY_ICONS = {
  critical: AlertOctagon,
  high: AlertTriangle,
  medium: CircleDot,
  low: Info,
} as const;

/** Severity with icon + text (never color alone). */
export function SeverityBadge({ severity }: { severity: string }) {
  const Icon = SEVERITY_ICONS[severity as keyof typeof SEVERITY_ICONS] ?? Info;
  return (
    <Badge tone={severityTone(severity)} className="gap-1">
      <Icon className="size-3" aria-hidden />
      {titleCase(severity)}
      <span className="sr-only"> severity</span>
    </Badge>
  );
}

export function ConflictStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={conflictStatusTone(status)} dot>
      {titleCase(status)}
    </Badge>
  );
}

export function ConflictTypeBadge({ type }: { type: string }) {
  return <Badge tone="neutral">{conflictTypeLabel(type)}</Badge>;
}

export function RightsTypeBadge({ rightsType }: { rightsType: string | null | undefined }) {
  return <Badge tone="primary">{rightsTypeLabel(rightsType)}</Badge>;
}

export function ShareStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={shareStatusTone(status)} dot>
      {titleCase(status)}
    </Badge>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  return (
    <Badge tone={verificationTone(status)} dot>
      {titleCase(status)}
    </Badge>
  );
}

export function TotalStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={totalStatusTone(status)} dot>
      {TOTAL_STATUS_LABELS[status as TotalStatus] ?? titleCase(status)}
    </Badge>
  );
}
