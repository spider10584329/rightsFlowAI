"use client";

import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export interface ComboOption {
  id: string;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SearchComboboxProps {
  /** Currently selected option (label shown in the trigger). */
  value: ComboOption | null;
  onChange: (option: ComboOption | null) => void;
  options: ComboOption[];
  search: string;
  onSearchChange: (value: string) => void;
  loading?: boolean;
  error?: unknown;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  clearable?: boolean;
  id?: string;
  className?: string;
  size?: "sm" | "md";
  icon?: ReactNode;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true | boolean;
  /** Footer slot (e.g. a link to create a new record). */
  footer?: ReactNode;
  /** Notified when the popover opens or closes (pickers start querying on first open). */
  onOpenChange?: (open: boolean) => void;
}

/** Searchable single-select (ARIA combobox pattern) used by the party, asset and contract pickers. */
export function SearchCombobox({
  value,
  onChange,
  options,
  search,
  onSearchChange,
  loading,
  error,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled,
  clearable,
  id,
  className,
  size = "md",
  icon,
  footer,
  onOpenChange,
  ...aria
}: SearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(search);
  const [active, setActive] = useState(0);
  const listId = useId();

  // Debounce the search text before it reaches the query.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearchChange(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, search, onSearchChange]);

  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const activeOption = options[activeIndex];

  const choose = (option: ComboOption) => {
    if (option.disabled) return;
    onChange(option);
    setOpen(false);
    onOpenChange?.(false);
  };

  return (
    <div className={cn("relative", className)}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            disabled={disabled}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-label={aria["aria-label"]}
            aria-describedby={aria["aria-describedby"]}
            aria-invalid={aria["aria-invalid"] || undefined}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-sm text-fg shadow-xs transition-[border-color,box-shadow] hover:border-fg-subtle/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger",
              size === "sm" ? "h-8 text-[13px]" : "h-9",
              clearable && value && "pr-9",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {icon ? <span className="shrink-0 text-fg-subtle [&_svg]:size-4">{icon}</span> : null}
              <span className={cn("truncate", !value && "text-fg-subtle")}>{value ? value.label : placeholder}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0">
          <div className="border-b border-border p-2">
            <Input
              value={draft}
              autoFocus
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
              leadingIcon={<Search aria-hidden />}
              trailing={loading ? <Spinner size="xs" className="mr-2 text-fg-subtle" /> : null}
              className="h-8 text-[13px]"
              onChange={(event) => {
                setDraft(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, options.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (activeOption) choose(activeOption);
                }
              }}
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Results" className="scrollbar-thin max-h-72 overflow-y-auto p-1">
            {error ? (
              <li className="px-3 py-4 text-center text-xs text-danger">{errorMessage(error)}</li>
            ) : options.length === 0 && !loading ? (
              <li className="px-3 py-6 text-center text-xs text-fg-subtle">{emptyText}</li>
            ) : null}
            {options.map((option, index) => {
              const selected = value?.id === option.id;
              return (
                <li
                  key={option.id}
                  id={`${listId}-${option.id}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[13px]",
                    index === activeIndex && "bg-surface-2",
                    option.disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <Check className={cn("mt-0.5 size-3.5 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">{option.label}</span>
                    {option.description ? <span className="block truncate text-xs text-fg-subtle">{option.description}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {footer ? <div className="border-t border-border p-2 text-xs">{footer}</div> : null}
        </PopoverContent>
      </Popover>
      {clearable && value && !disabled ? (
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => onChange(null)}
          className="absolute right-7 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
