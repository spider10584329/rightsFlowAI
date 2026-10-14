import { Check, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";

import { allocationType, matchStatus, runStatus, statementStatus } from "@/components/royalties/labels";
import { decimalSign, formatMoney, type FormatMoneyOptions } from "@/components/royalties/money";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const AI_ADVISORY = "AI-generated · advisory — verify before relying on it. Not legal advice.";

export interface MoneyProps extends FormatMoneyOptions {
  amount: string | null | undefined;
  currency: string | null | undefined;
  className?: string;
  /** Color negative values (the minus sign is always shown as text too). */
  toneNegative?: boolean;
}

/** Exact decimal string rendered as money; the full-precision value is in the tooltip. */
export function Money({ amount, currency, className, toneNegative, ...options }: MoneyProps) {
  if (amount === null || amount === undefined || amount === "") return <span className={cn("text-fg-subtle", className)}>—</span>;
  const negative = decimalSign(amount) < 0;
  return (
    <span
      className={cn("whitespace-nowrap tabular-nums", toneNegative && negative && "text-danger", className)}
      title={`${amount} ${currency ?? ""}`.trim()}
    >
      {formatMoney(amount, currency, options)}
    </span>
  );
}

export function StatementStatusBadge({ status, size }: { status: string; size?: "sm" | "md" }) {
  const info = statementStatus(status);
  return (
    <Badge tone={info.tone} dot size={size}>
      {info.label}
    </Badge>
  );
}

export function RunStatusBadge({ status, size }: { status: string; size?: "sm" | "md" }) {
  const info = runStatus(status);
  return (
    <Badge tone={info.tone} dot size={size}>
      {info.label}
    </Badge>
  );
}

export function AllocationTypeBadge({ type }: { type: string }) {
  const info = allocationType(type);
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function MatchStatusBadge({ status }: { status: string }) {
  const info = matchStatus(status);
  return (
    <Badge tone={info.tone} dot>
      {info.label}
    </Badge>
  );
}

export function AiAdvisoryNotice({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-fg-muted", className)}>
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
      <span>
        <span className="font-medium text-fg">{AI_ADVISORY}</span>
        {children ? <> {children}</> : null}
      </span>
    </p>
  );
}

export interface StepItem {
  key: string;
  label: string;
  description?: ReactNode;
  state: "complete" | "current" | "upcoming" | "cancelled";
}

/** Horizontal (stacked on mobile) progress stepper. State is conveyed with text, not just color. */
export function Stepper({ steps, label, className }: { steps: StepItem[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={className}>
      <ol className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-0">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={step.key} className="flex flex-1 items-start gap-3 sm:flex-col sm:gap-2" aria-current={step.state === "current" ? "step" : undefined}>
              <div className="flex items-center sm:w-full">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    step.state === "complete" && "border-success bg-success text-white",
                    step.state === "current" && "border-primary bg-primary-soft text-primary-soft-fg ring-3 ring-primary/15",
                    step.state === "upcoming" && "border-border-strong bg-surface text-fg-subtle",
                    step.state === "cancelled" && "border-danger bg-danger-soft text-danger",
                  )}
                  aria-hidden
                >
                  {step.state === "complete" ? <Check className="size-3.5" /> : step.state === "cancelled" ? <X className="size-3.5" /> : index + 1}
                </span>
                {last ? null : (
                  <span className={cn("mx-2 hidden h-px flex-1 sm:block", step.state === "complete" ? "bg-success" : "bg-border")} aria-hidden />
                )}
              </div>
              <div className="min-w-0 sm:pr-4">
                <p className={cn("text-[13px] font-medium", step.state === "upcoming" ? "text-fg-muted" : "text-fg")}>{step.label}</p>
                <p className="text-xs text-fg-subtle">
                  <span className="sr-only">Status: </span>
                  {step.state === "complete" ? "Done" : step.state === "current" ? "Current step" : step.state === "cancelled" ? "Cancelled" : "Not started"}
                  {step.description ? <> · {step.description}</> : null}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Thin labelled progress bar. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{label}</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

/** Small "a of b" ratio with a meter, for row counts. */
export function RatioMeter({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="min-w-24 space-y-1">
      <p className="text-xs tabular-nums text-fg">
        {value.toLocaleString()} <span className="text-fg-subtle">/ {total.toLocaleString()}</span>
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
        <div className={cn("h-full rounded-full", pct === 100 ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Formats an ISO date (YYYY-MM-DD) without time-zone shifts. */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return "—";
  return `${formatIsoDate(start)} – ${formatIsoDate(end)}`;
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
