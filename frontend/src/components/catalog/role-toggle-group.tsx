"use client";

import { Check } from "lucide-react";

import { codeLabel } from "@/components/catalog/labels";
import { cn } from "@/lib/utils";

/** Multi-select as toggle chips (`aria-pressed`), keeping the option order. */
export function RoleToggleGroup<R extends string>({
  options,
  value,
  onChange,
  disabled,
  "aria-describedby": describedBy,
}: {
  options: readonly R[];
  value: readonly R[];
  onChange: (next: R[]) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
}) {
  const selected = new Set(value);
  return (
    <div className="flex flex-wrap gap-1.5" aria-describedby={describedBy}>
      {options.map((option) => {
        const on = selected.has(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(options.filter((candidate) => (candidate === option ? !on : selected.has(candidate))))}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
              on ? "border-primary/40 bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {on ? <Check className="size-3" aria-hidden /> : null}
            {codeLabel(option)}
          </button>
        );
      })}
    </div>
  );
}
