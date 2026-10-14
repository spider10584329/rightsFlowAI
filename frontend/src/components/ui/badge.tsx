import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "primary" | "accent" | "success" | "warning" | "danger" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-fg-muted ring-border",
  primary: "bg-primary-soft text-primary-soft-fg ring-primary/20",
  accent: "bg-accent-soft text-accent-soft-fg ring-accent/20",
  success: "bg-success-soft text-success-soft-fg ring-success/20",
  warning: "bg-warning-soft text-warning-soft-fg ring-warning/25",
  danger: "bg-danger-soft text-danger-soft-fg ring-danger/20",
  info: "bg-info-soft text-info-soft-fg ring-info/20",
};

const DOTS: Record<BadgeTone, string> = {
  neutral: "bg-fg-subtle",
  primary: "bg-primary",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
  /** Shows a leading status dot. */
  dot?: boolean;
  size?: "sm" | "md";
}

export function Badge({ tone = "neutral", dot = false, size = "sm", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "h-5 px-2 text-2xs" : "h-6 px-2.5 text-xs",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className={cn("size-1.5 rounded-full", DOTS[tone])} aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Maps common backend status strings to badge tones. */
export function statusTone(status: string | null | undefined): BadgeTone {
  switch ((status ?? "").toLowerCase()) {
    case "active":
    case "accepted":
    case "approved":
    case "paid":
    case "completed":
    case "succeeded":
    case "sent":
    case "verified":
      return "success";
    case "pending":
    case "queued":
    case "processing":
    case "running":
    case "draft":
      return "info";
    case "warning":
    case "expiring":
    case "logged":
    case "needs_review":
    case "on_hold":
      return "warning";
    case "failed":
    case "error":
    case "critical":
    case "rejected":
    case "revoked":
    case "declined":
    case "expired":
    case "cancelled":
    case "inactive":
      return "danger";
    default:
      return "neutral";
  }
}
