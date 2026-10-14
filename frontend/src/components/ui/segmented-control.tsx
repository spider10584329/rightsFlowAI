"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Names the group, e.g. "Group summary by". */
  "aria-label": string;
  className?: string;
}

/**
 * Single-choice filter/view switch: a labelled group of toggle buttons
 * (`aria-pressed`). Use this instead of Tabs when there are no tab panels.
 */
export function SegmentedControl<T extends string>({ value, onValueChange, options, "aria-label": ariaLabel, className }: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border bg-surface-2 p-0.5", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onValueChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5",
              selected && "bg-surface text-fg shadow-xs",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
