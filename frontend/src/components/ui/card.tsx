import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl border border-border bg-surface shadow-sm", className)} {...props} />;
}

export interface CardHeaderProps extends Omit<ComponentProps<"div">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions, className, ...props }: CardHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4", className)} {...props}>
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
        {description ? <p className="text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-border bg-surface-2/60 px-5 py-3", className)}
      {...props}
    />
  );
}
