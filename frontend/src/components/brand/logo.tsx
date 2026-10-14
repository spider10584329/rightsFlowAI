import { cn } from "@/lib/utils";

/** RightsFlow mark: a rounded tile with a stylised sound-wave flowing into a split. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="rf-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="0.6" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#rf-mark)" />
      <path
        d="M6 17.5h2.2l1.6-5 2.4 9.5 2.3-12 2.2 10.5 1.6-4.5H20c1.8 0 2.8-1.2 3.8-2.6L26 10.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M20 17.5c1.8 0 2.8 1.6 3.8 3.1L26 23.5" fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, showText = true, inverted = false }: { className?: string; showText?: boolean; inverted?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {showText ? (
        <span className={cn("text-[15px] font-semibold tracking-tight", inverted ? "text-white" : "text-fg")}>
          RightsFlow<span className={inverted ? "text-indigo-300" : "text-primary"}> AI</span>
        </span>
      ) : null}
    </span>
  );
}
