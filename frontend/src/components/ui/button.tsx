import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "soft" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-55 [&_svg]:shrink-0";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg shadow-xs hover:bg-primary-hover active:translate-y-px",
  secondary: "bg-surface-2 text-fg hover:bg-surface-3 border border-transparent",
  outline: "border border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-2",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger-solid text-white shadow-xs hover:bg-danger-solid-hover active:translate-y-px",
  soft: "bg-primary-soft text-primary-soft-fg hover:brightness-[0.97] dark:hover:brightness-125",
  link: "h-auto px-0 text-primary underline-offset-4 hover:underline",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
  sm: "h-8 px-3 text-[13px] [&_svg]:size-4",
  md: "h-9 px-3.5 text-sm [&_svg]:size-4",
  lg: "h-11 px-5 text-[15px] [&_svg]:size-[18px]",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(BASE, VARIANTS[variant], variant === "link" ? "" : SIZES[size], className);
}

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  leftIcon,
  rightIcon,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size={size === "lg" ? "md" : "sm"} /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}

export interface ButtonLinkProps extends ComponentProps<typeof Link> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

/** A Next.js `<Link>` styled as a button. */
export function ButtonLink({ variant = "primary", size = "md", leftIcon, rightIcon, className, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={buttonClasses({ variant, size, className })} {...props}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}
