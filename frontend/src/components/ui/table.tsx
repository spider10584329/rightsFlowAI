import type { ComponentProps } from "react";

import { ScrollRegion } from "@/components/ui/scroll-region";
import { cn } from "@/lib/utils";

/** Scroll container + table. Wrap in a Card for the bordered look. */
export function Table({ className, containerClassName, ...props }: ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <ScrollRegion className={containerClassName}>
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </ScrollRegion>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("bg-surface-2/70 [&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors hover:bg-surface-2/50 data-[state=selected]:bg-primary-soft/60",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 whitespace-nowrap px-4 text-left align-middle text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle first:pl-5 last:pr-5",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle text-fg first:pl-5 last:pr-5", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("mt-3 text-xs text-fg-subtle", className)} {...props} />;
}
