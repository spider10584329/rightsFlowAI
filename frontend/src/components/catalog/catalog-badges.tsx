import { CheckCircle2 } from "lucide-react";

import { BAND_META, codeLabel, completenessBand, missingLabel, STATUS_TONE, VERIFICATION_TONE } from "@/components/catalog/labels";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>
      {codeLabel(status)}
    </Badge>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  return (
    <Badge tone={VERIFICATION_TONE[status] ?? "neutral"}>
      {codeLabel(status)}
    </Badge>
  );
}

/** Monospace identifier or a muted "missing" marker. */
export function IdentifierText({ value, missingLabel: missing = "Missing", className }: { value: string | null | undefined; missingLabel?: string; className?: string }) {
  if (!value) return <span className="text-xs italic text-fg-subtle">{missing}</span>;
  return <span className={cn("whitespace-nowrap font-mono text-[12.5px] text-fg", className)}>{value}</span>;
}

/** Compact score bar for tables: number + band-coloured bar with a text band label for screen readers. */
export function CompletenessBar({ score, className }: { score: number; className?: string }) {
  const band = completenessBand(score);
  const meta = BAND_META[band];
  return (
    <div className={cn("flex min-w-24 items-center gap-2", className)} title={`${score}% complete (${meta.label})`}>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-valuetext={`${score}% complete, ${meta.label}`}
        aria-label="Metadata completeness"
      >
        <div className={cn("h-full rounded-full", meta.bar)} style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      <span className="text-xs font-medium tabular-nums text-fg-muted">{score}%</span>
    </div>
  );
}

/** Larger completeness meter for detail pages, listing the missing fields. */
export function CompletenessMeter({ score, missing }: { score: number; missing: string[] }) {
  const band = completenessBand(score);
  const meta = BAND_META[band];
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-fg">
            {score}
            <span className="text-lg text-fg-subtle">%</span>
          </p>
          <p className="mt-1 text-xs text-fg-muted">Metadata completeness</p>
        </div>
        <Badge tone={meta.tone} size="md">
          {meta.label}
        </Badge>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-valuetext={`${score}% complete, ${meta.label}`}
        aria-label="Metadata completeness"
      >
        <div className={cn("h-full rounded-full transition-[width]", meta.bar)} style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      {missing.length > 0 ? (
        <div className="space-y-2">
          <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Missing ({missing.length})</p>
          <ul className="flex flex-wrap gap-1.5">
            {missing.map((key) => (
              <li key={key}>
                <Badge tone="warning">{missingLabel(key)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[13px] text-success-soft-fg">
          <CheckCircle2 className="size-4 text-success" aria-hidden /> All tracked metadata is present.
        </p>
      )}
    </div>
  );
}
