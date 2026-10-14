import { meterPercent, meterStatusText, meterTone } from "@/components/billing/usage";
import { cn } from "@/lib/utils";

const FILL = { normal: "bg-primary", warning: "bg-warning", danger: "bg-danger" } as const;
const TRACK = { normal: "bg-primary-soft", warning: "bg-warning-soft", danger: "bg-danger-soft" } as const;

/** "0.04" would round to "0%" although something is used; show "<0.1%" instead. */
export function formatShare(percent: number, used: number): string {
  if (used > 0 && percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export interface UsageMeterProps {
  label: string;
  used: number;
  limit: number | null | undefined;
  percentage?: string | null;
  exceeded?: boolean;
  formatValue?: (value: number) => string;
  className?: string;
}

/** Accessible meter: role="meter" with text values and a status word, never color alone. */
export function UsageMeter({ label, used, limit, percentage, exceeded = false, formatValue = (value) => value.toLocaleString(), className }: UsageMeterProps) {
  const percent = meterPercent(used, limit, percentage);
  const tone = meterTone(percent, exceeded);
  const status = meterStatusText(percent, exceeded);
  const unlimited = limit === null || limit === undefined;
  const valueText = unlimited ? `${formatValue(used)} used, unlimited` : `${formatValue(used)} of ${formatValue(limit)}${status ? ` — ${status.toLowerCase()}` : ""}`;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-fg">{label}</span>
        <span className="text-fg-muted tabular-nums">
          {formatValue(used)} <span className="text-fg-subtle">/ {unlimited ? "Unlimited" : formatValue(limit)}</span>
        </span>
      </div>
      {unlimited ? (
        <div className="h-2 rounded-full bg-surface-2" aria-hidden />
      ) : (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent ?? 0)}
          aria-valuetext={valueText}
          className={cn("h-2 overflow-hidden rounded-full", TRACK[tone])}
        >
          <div className={cn("h-full rounded-full transition-[width]", FILL[tone])} style={{ width: `${percent ?? 0}%` }} />
        </div>
      )}
      <div className="flex justify-between text-2xs text-fg-subtle">
        <span>{unlimited ? "No limit on this plan" : `${formatShare(percent ?? 0, used)} used`}</span>
        {status ? <span className={cn("font-semibold", tone === "danger" ? "text-danger" : "text-warning")}>{status}</span> : null}
      </div>
    </div>
  );
}
