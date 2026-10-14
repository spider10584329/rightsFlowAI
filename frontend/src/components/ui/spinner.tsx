import { cn } from "@/lib/utils";

export interface SpinnerProps {
  className?: string;
  size?: "xs" | "sm" | "md" | "lg";
  /** Accessible label; omit when the spinner is decorative (e.g. inside a labelled button). */
  label?: string;
}

const SIZES = { xs: "size-3", sm: "size-4", md: "size-5", lg: "size-8" } as const;

export function Spinner({ className, size = "sm", label }: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex shrink-0", className)}
    >
      <svg className={cn("animate-spin", SIZES[size])} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}
