import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("animate-shimmer rounded-md bg-surface-3", className)} {...props} />;
}

/** Generic page placeholder used as the Suspense fallback for pages. */
export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="space-y-3">
          {Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
