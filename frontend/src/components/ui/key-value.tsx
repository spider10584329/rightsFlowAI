import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Render the value in a monospace font (ids, codes). */
  mono?: boolean;
}

export function KeyValueList({ items, className, columns = 1 }: { items: KeyValueItem[]; className?: string; columns?: 1 | 2 }) {
  return (
    <dl className={cn("grid gap-x-8", columns === 2 ? "sm:grid-cols-2" : "grid-cols-1", className)}>
      {items.map((item, index) => (
        <div key={index} className="flex flex-col gap-0.5 border-b border-border py-3 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-[13px] text-fg-muted">{item.label}</dt>
          <dd className={cn("min-w-0 break-words text-sm text-fg sm:text-right", item.mono && "font-mono text-[13px]")}>
            {item.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
