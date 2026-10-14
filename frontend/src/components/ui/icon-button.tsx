import type { ComponentProps, ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
  /** Required accessible name (icon-only buttons have no visible text). */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "outline" | "soft" | "danger";
  size?: "xs" | "sm" | "md";
  loading?: boolean;
}

const VARIANTS = {
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  outline: "border border-border bg-surface text-fg-muted shadow-xs hover:bg-surface-2 hover:text-fg",
  soft: "bg-primary-soft text-primary-soft-fg hover:brightness-95",
  danger: "text-danger hover:bg-danger-soft",
} as const;

const SIZES = { xs: "size-7 [&_svg]:size-3.5", sm: "size-8 [&_svg]:size-4", md: "size-9 [&_svg]:size-[18px]" } as const;

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
  disabled,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={props.title ?? label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : icon}
    </button>
  );
}
