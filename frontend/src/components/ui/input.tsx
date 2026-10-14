import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const fieldControlClasses =
  "w-full rounded-md border border-border-strong bg-surface text-sm text-fg shadow-xs transition-[border-color,box-shadow] placeholder:text-fg-subtle hover:border-fg-subtle/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25";

export interface InputProps extends ComponentProps<"input"> {
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
}

export function Input({ className, leadingIcon, trailing, type = "text", ...props }: InputProps) {
  if (!leadingIcon && !trailing) {
    return <input type={type} className={cn(fieldControlClasses, "h-9 px-3", className)} {...props} />;
  }
  return (
    <div className="relative">
      {leadingIcon ? (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fg-subtle [&_svg]:size-4">
          {leadingIcon}
        </span>
      ) : null}
      <input
        type={type}
        className={cn(fieldControlClasses, "h-9 px-3", leadingIcon && "pl-9", trailing && "pr-10", className)}
        {...props}
      />
      {trailing ? <span className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</span> : null}
    </div>
  );
}
