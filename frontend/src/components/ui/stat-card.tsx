import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  /** Change versus the comparison period, e.g. "+12.4%". */
  delta?: string;
  trend?: "up" | "down" | "flat";
  /** Whether "up" is good (green) - false for metrics like disputes. */
  upIsGood?: boolean;
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function StatCard({ label, value, icon, delta, trend = "flat", upIsGood = true, hint, loading, className }: StatCardProps) {
  const positive = trend === "flat" ? null : (trend === "up") === upIsGood;
  const TrendIcon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;
  return (
    <div className={cn("rounded-xl border border-border bg-surface p-5 shadow-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-fg-muted">{label}</p>
        {icon ? (
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-fg [&_svg]:size-4">{icon}</span>
        ) : null}
      </div>
      <div className="mt-3">
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <p className="text-[26px] font-semibold leading-none tracking-tight text-fg tabular-nums">{value}</p>
        )}
      </div>
      {delta || hint ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {delta ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tabular-nums",
                positive === null ? "bg-surface-2 text-fg-muted" : positive ? "bg-success-soft text-success-soft-fg" : "bg-danger-soft text-danger-soft-fg",
              )}
            >
              <TrendIcon className="size-3" aria-hidden />
              {delta}
            </span>
          ) : null}
          {hint ? <span className="text-fg-subtle">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
