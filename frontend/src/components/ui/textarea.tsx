import type { ComponentProps } from "react";

import { fieldControlClasses } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function Textarea({ className, rows = 4, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(fieldControlClasses, "min-h-20 px-3 py-2 leading-relaxed", className)} {...props} />;
}
