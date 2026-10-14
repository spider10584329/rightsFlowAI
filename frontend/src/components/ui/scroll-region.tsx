"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

export interface ScrollRegionProps extends ComponentProps<"div"> {
  /** Accessible name; defaults to the text of a direct child table's caption. */
  label?: string;
}

/**
 * Horizontal scroll container for wide tables. While its content actually
 * overflows it becomes a focusable, named region so keyboard users can scroll
 * it; otherwise it adds no tab stop. `relative` keeps absolutely positioned
 * descendants (e.g. `sr-only` text) clipped instead of widening the page.
 */
export function ScrollRegion({ label, className, ...props }: ScrollRegionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<{ scrollable: boolean; name?: string }>({ scrollable: false });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const scrollable = element.scrollWidth > element.clientWidth + 1;
      const name = label ?? element.querySelector(":scope > table > caption")?.textContent?.trim() ?? undefined;
      setRegion((current) => (current.scrollable === scrollable && current.name === name ? current : { scrollable, name }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [label]);

  return (
    <div
      ref={ref}
      role={region.scrollable ? "region" : undefined}
      aria-label={region.scrollable ? region.name || "Scrollable table" : undefined}
      tabIndex={region.scrollable ? 0 : undefined}
      className={cn(
        "scrollbar-thin relative w-full overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}
