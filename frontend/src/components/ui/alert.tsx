import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type AlertTone = "info" | "success" | "warning" | "danger";

const TONES: Record<AlertTone, { box: string; icon: ReactNode }> = {
  info: { box: "border-info/25 bg-info-soft text-info-soft-fg", icon: <Info aria-hidden /> },
  success: { box: "border-success/25 bg-success-soft text-success-soft-fg", icon: <CheckCircle2 aria-hidden /> },
  warning: { box: "border-warning/30 bg-warning-soft text-warning-soft-fg", icon: <AlertTriangle aria-hidden /> },
  danger: { box: "border-danger/25 bg-danger-soft text-danger-soft-fg", icon: <OctagonAlert aria-hidden /> },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Use `role="alert"` (assertive). Defaults to `status` for non-danger tones. */
  assertive?: boolean;
}

export function Alert({ tone = "info", title, children, action, className, assertive }: AlertProps) {
  const config = TONES[tone];
  return (
    <div
      role={assertive || tone === "danger" ? "alert" : "status"}
      className={cn("flex flex-col gap-3 rounded-lg border px-4 py-3 text-[13px] sm:flex-row sm:items-center", config.box, className)}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 shrink-0 [&_svg]:size-4">{config.icon}</span>
        <div className="min-w-0 space-y-0.5">
          {title ? <p className="font-semibold">{title}</p> : null}
          {children ? <div className="leading-relaxed opacity-95">{children}</div> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">{action}</div> : null}
    </div>
  );
}
