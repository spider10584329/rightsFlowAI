import { cn, initials } from "@/lib/utils";

const PALETTE = [
  "bg-[#e0e7ff] text-[#3730a3] dark:bg-[#272c5c] dark:text-[#c7d2fe]",
  "bg-[#ccfbf1] text-[#115e59] dark:bg-[#0f3633] dark:text-[#99f6e4]",
  "bg-[#fae8ff] text-[#86198f] dark:bg-[#3b1840] dark:text-[#f5d0fe]",
  "bg-[#fef3c7] text-[#92400e] dark:bg-[#3a2a0c] dark:text-[#fde68a]",
  "bg-[#e0f2fe] text-[#075985] dark:bg-[#0c2c40] dark:text-[#bae6fd]",
  "bg-[#ffe4e6] text-[#9f1239] dark:bg-[#3d1520] dark:text-[#fecdd3]",
];

function paletteIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % PALETTE.length;
}

export interface AvatarProps {
  name: string | null | undefined;
  /** Stable seed for the colour (defaults to the name). */
  seed?: string;
  size?: "xs" | "sm" | "md" | "lg";
  shape?: "circle" | "square";
  className?: string;
}

const SIZES = { xs: "size-5 text-[9px]", sm: "size-7 text-[11px]", md: "size-8 text-xs", lg: "size-11 text-sm" } as const;

/**
 * Initials avatar with a deterministic colour. Decorative: pair it with visible text.
 * The initials are drawn as CSS generated content, not text, so they don't count as
 * visible label text for a button or link that names itself with `aria-label`.
 */
export function Avatar({ name, seed, size = "md", shape = "circle", className }: AvatarProps) {
  return (
    <span
      aria-hidden
      data-initials={initials(name)}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold tracking-wide before:content-[attr(data-initials)]",
        shape === "circle" ? "rounded-full" : "rounded-md",
        SIZES[size],
        PALETTE[paletteIndex(seed ?? name ?? "?")],
        className,
      )}
    />
  );
}
