"use client";

import { ChevronDown, Globe2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useReferenceList } from "@/lib/api/hooks/reference";
import type { ReferenceItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

import { normalizeScope, scopeSummary, toggleExcluded, toggleTerritory, WORLD } from "./territory-scope";

export interface TerritorySelectProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** Excluded territories (only used when WORLD is selected). */
  excluded?: string[];
  onExcludedChange?: (value: string[]) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  size?: "sm" | "md";
  "aria-describedby"?: string;
  "aria-invalid"?: true | boolean;
  "aria-label"?: string;
  /** Test seam / offline fallback: the territory list to show. */
  options?: ReferenceItem[];
  /** Trigger text when nothing is selected (e.g. "All territories" where empty means unrestricted). */
  emptyLabel?: string;
}

const FALLBACK: ReferenceItem[] = [
  { code: WORLD, name: "Worldwide" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "JP", name: "Japan" },
  { code: "AU", name: "Australia" },
];

/** Multi-select of territories with WORLD + exclusions, keyboard accessible (Radix popover + native checkboxes semantics). */
export function TerritorySelect({
  value,
  onChange,
  excluded = [],
  onExcludedChange,
  disabled,
  id,
  className,
  size = "md",
  options,
  emptyLabel,
  ...aria
}: TerritorySelectProps) {
  const reference = useReferenceList("territories");
  const items = useMemo(() => {
    const list = options ?? (reference.data && reference.data.length > 0 ? reference.data : FALLBACK);
    return list.some((item) => item.code === WORLD) ? list : [{ code: WORLD, name: "Worldwide" }, ...list];
  }, [options, reference.data]);
  const names = useMemo(() => new Map(items.map((item) => [item.code, item.name])), [items]);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [search, setSearch] = useState("");
  const listId = useId();

  const worldSelected = value.includes(WORLD);
  const canExclude = Boolean(onExcludedChange) && worldSelected;
  const activeMode = canExclude ? mode : "include";
  const term = search.trim().toLowerCase();
  const visible = items.filter((item) => {
    if (activeMode === "exclude" && item.code === WORLD) return false;
    return !term || item.code.toLowerCase().includes(term) || item.name.toLowerCase().includes(term);
  });

  const commit = (territories: string[], nextExcluded: string[]) => {
    const scope = normalizeScope({ territories, excluded: nextExcluded });
    onChange(scope.territories);
    if (onExcludedChange && (scope.excluded.length !== excluded.length || scope.excluded.some((code, i) => code !== excluded[i]))) {
      onExcludedChange(scope.excluded);
    }
  };

  const toggle = (code: string) => {
    if (activeMode === "exclude") commit(value, toggleExcluded(excluded, code));
    else commit(toggleTerritory(value, code), excluded);
  };

  const summary = value.length === 0 && emptyLabel ? emptyLabel : scopeSummary({ territories: value, excluded: worldSelected ? excluded : [] }, names);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={aria["aria-label"]}
          aria-describedby={aria["aria-describedby"]}
          data-invalid={aria["aria-invalid"] ? "true" : undefined}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-sm text-fg shadow-xs transition-[border-color,box-shadow] hover:border-fg-subtle/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60 data-[invalid=true]:border-danger",
            size === "sm" ? "h-8 text-[13px]" : "h-9",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Globe2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <span className={cn("truncate", value.length === 0 && "text-fg-subtle")}>{summary}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="space-y-2 border-b border-border p-3">
          {onExcludedChange ? (
            <div role="radiogroup" aria-label="Territory list mode" className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-0.5 text-xs font-medium">
              {(["include", "exclude"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={activeMode === option}
                  disabled={option === "exclude" && !worldSelected}
                  onClick={() => setMode(option)}
                  className={cn(
                    "rounded px-2 py-1 transition-colors disabled:opacity-50",
                    activeMode === option ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg",
                  )}
                >
                  {option === "include" ? "Included" : `Excluded${excluded.length ? ` (${excluded.length})` : ""}`}
                </button>
              ))}
            </div>
          ) : null}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search country or code"
            aria-label="Search territories"
            aria-controls={listId}
            className="h-8 text-[13px]"
            autoFocus
          />
          {onExcludedChange && !worldSelected ? (
            <p className="text-2xs text-fg-subtle">Select WORLD to carve out excluded territories.</p>
          ) : null}
        </div>
        <ul id={listId} aria-label={activeMode === "exclude" ? "Excluded territories" : "Included territories"} className="scrollbar-thin max-h-64 overflow-y-auto p-1">
          {visible.length === 0 ? <li className="px-3 py-6 text-center text-xs text-fg-subtle">No territories match.</li> : null}
          {visible.map((item) => {
            const checked = activeMode === "exclude" ? excluded.includes(item.code) : value.includes(item.code);
            const checkboxId = `${listId}-${item.code}`;
            return (
              <li key={item.code}>
                <label htmlFor={checkboxId} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2">
                  <Checkbox id={checkboxId} checked={checked} onCheckedChange={() => toggle(item.code)} />
                  <span className="w-12 shrink-0 font-mono text-2xs text-fg-subtle">{item.code}</span>
                  <span className="truncate">{item.code === WORLD ? "Worldwide (all territories)" : item.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {(value.length > 0 || excluded.length > 0) && !disabled ? (
          <div className="flex flex-wrap gap-1 border-t border-border p-2">
            {value.map((code) => (
              <Chip key={`in-${code}`} label={code} onRemove={() => commit(value.filter((item) => item !== code), excluded)} />
            ))}
            {worldSelected
              ? excluded.map((code) => (
                  <Chip key={`ex-${code}`} label={`not ${code}`} tone="danger" onRemove={() => commit(value, excluded.filter((item) => item !== code))} />
                ))
              : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Chip({ label, onRemove, tone }: { label: string; onRemove: () => void; tone?: "danger" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-2xs font-medium ring-1 ring-inset",
        tone === "danger" ? "bg-danger-soft text-danger-soft-fg ring-danger/20" : "bg-surface-2 text-fg-muted ring-border",
      )}
    >
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="rounded-full p-0.5 hover:bg-surface-3">
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
