import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14", className)}>
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-subtle shadow-xs [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {description ? <p className="text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
