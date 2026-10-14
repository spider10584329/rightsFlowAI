import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

import { fieldControlClasses } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Native `<select>` styled like other controls; best for long lists (time zones, countries). */
export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select className={cn(fieldControlClasses, "h-9 appearance-none pl-3 pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </div>
  );
}
