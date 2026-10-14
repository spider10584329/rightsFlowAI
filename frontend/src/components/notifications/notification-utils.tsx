import type { BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
    case "critical":
    case "danger":
      return "danger";
    default:
      return "info";
  }
}

const DOT: Record<BadgeTone, string> = {
  neutral: "bg-fg-subtle",
  primary: "bg-primary",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function NotificationSeverityDot({ severity, className }: { severity: string; className?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", DOT[severityTone(severity)], className)} aria-hidden />;
}

/** Only same-app relative links are followed (never external URLs from data). */
export function safeNotificationHref(link: string | null | undefined): string | null {
  if (!link) return null;
  if (!link.startsWith("/") || link.startsWith("//") || link.includes("\\")) return null;
  return link;
}
