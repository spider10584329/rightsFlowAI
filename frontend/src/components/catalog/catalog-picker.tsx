"use client";

import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { formatIswc } from "@/components/catalog/identifiers";
import { codeLabel } from "@/components/catalog/labels";
import { fieldControlClasses } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { QueryParams } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { useCatalogList, type CatalogItem, type Party, type Recording, type Work } from "@/lib/api/hooks/catalog";
import { cn } from "@/lib/utils";

export type PickerEntity = "party" | "work" | "recording";

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function primaryText(entity: PickerEntity, item: CatalogItem<PickerEntity>): string {
  if (entity === "party") return (item as Party).name;
  const record = item as Work | Recording;
  if (entity === "recording" && (record as Recording).version_title) return `${record.title} (${(record as Recording).version_title})`;
  return record.title;
}

function secondaryText(entity: PickerEntity, item: CatalogItem<PickerEntity>): ReactNode {
  if (entity === "party") {
    const party = item as Party;
    const parts = [party.roles.map(codeLabel).join(", ") || codeLabel(party.party_type), party.ipi_number ? `IPI ${party.ipi_number}` : null];
    return parts.filter(Boolean).join(" · ");
  }
  if (entity === "work") {
    const work = item as Work;
    const writers = work.contributors
      .map((contributor) => contributor.party_name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return [work.iswc ? formatIswc(work.iswc) : "No ISWC", writers].filter(Boolean).join(" · ");
  }
  const recording = item as Recording;
  return [recording.artist ?? "No artist", recording.isrc ?? "No ISRC"].join(" · ");
}

const SORT: Record<PickerEntity, string> = { party: "name", work: "title", recording: "title" };

export interface CatalogPickerProps {
  orgId: string;
  entity: PickerEntity;
  /** Label of the current selection (single-select mode). */
  selectedLabel?: string | null;
  selectedId?: string | null;
  onSelect: (item: CatalogItem<PickerEntity>) => void;
  placeholder?: string;
  /** Items already chosen elsewhere (hidden from results). */
  excludeIds?: readonly string[];
  /** Extra list filters, e.g. `{ role: "label" }`. */
  filters?: QueryParams;
  /** Shows a "Create “query”" option (inline party creation). */
  onCreateRequest?: (query: string) => void;
  createLabel?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true | boolean;
  "aria-required"?: true | boolean;
  className?: string;
}

/**
 * Searchable, keyboard-operable combobox over a catalog collection
 * (`GET /parties|works|recordings?q=`).
 */
export function CatalogPicker({
  orgId,
  entity,
  selectedLabel,
  selectedId,
  onSelect,
  placeholder = "Search…",
  excludeIds,
  filters,
  onCreateRequest,
  createLabel = "Create",
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
  ...aria
}: CatalogPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebouncedValue(query.trim());

  const params = useMemo(() => ({ q: debounced || undefined, page_size: 10, sort: SORT[entity], ...filters }), [debounced, entity, filters]);
  const list = useCatalogList(orgId, entity, params, { enabled: open });
  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const results = useMemo(() => (list.data?.items ?? []).filter((item) => !excluded.has(item.id)), [list.data, excluded]);
  const showCreate = Boolean(onCreateRequest) && query.trim().length > 0;
  const optionCount = results.length + (showCreate ? 1 : 0);
  const activeIndex = optionCount === 0 ? -1 : Math.min(active, optionCount - 1);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const choose = (index: number) => {
    if (index < results.length) {
      onSelect(results[index]);
      close();
    } else if (showCreate && onCreateRequest) {
      const name = query.trim();
      close();
      onCreateRequest(name);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (optionCount === 0 ? 0 : (current + 1) % optionCount));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (optionCount === 0 ? 0 : (current - 1 + optionCount) % optionCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) choose(activeIndex);
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          aria-haspopup="listbox"
          aria-expanded={open}
          // Keep the visible text in the accessible name (WCAG 2.5.3, label in name).
          aria-label={ariaLabel ? `${ariaLabel}: ${selectedLabel || placeholder}` : undefined}
          {...aria}
          className={cn(
            fieldControlClasses,
            "flex h-9 items-center justify-between gap-2 px-3 text-left",
            !selectedLabel && "text-fg-subtle",
            className,
          )}
        >
          <span className="truncate">{selectedLabel || placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[min(26rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={`Search ${entity === "party" ? "parties" : `${entity}s`}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="h-10 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
          {list.isFetching ? <Spinner size="sm" /> : null}
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="scrollbar-thin max-h-72 overflow-y-auto p-1">
          {list.error ? (
            <li className="px-3 py-4 text-center text-[13px] text-danger">{errorMessage(list.error)}</li>
          ) : null}
          {!list.error && list.isLoading ? <li className="px-3 py-4 text-center text-[13px] text-fg-subtle">Searching…</li> : null}
          {!list.error && !list.isLoading && results.length === 0 ? (
            <li className="px-3 py-4 text-center text-[13px] text-fg-subtle">{debounced ? `No matches for “${debounced}”` : "Nothing here yet"}</li>
          ) : null}
          {results.map((item, index) => {
            const selected = item.id === selectedId;
            return (
              <li
                key={item.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5",
                  index === activeIndex && "bg-surface-2",
                )}
              >
                <Check className={cn("mt-0.5 size-4 shrink-0 text-primary", !selected && "invisible")} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{primaryText(entity, item)}</span>
                  <span className="block truncate text-xs text-fg-subtle">{secondaryText(entity, item)}</span>
                </span>
              </li>
            );
          })}
          {showCreate ? (
            <li
              id={optionId(results.length)}
              role="option"
              aria-selected={activeIndex === results.length}
              onMouseEnter={() => setActive(results.length)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(results.length)}
              className={cn(
                "mt-1 flex cursor-pointer items-center gap-2 rounded-md border-t border-border px-2 py-2 text-sm text-primary",
                activeIndex === results.length && "bg-primary-soft",
              )}
            >
              <Plus className="size-4 shrink-0" aria-hidden />
              <span className="truncate">
                {createLabel} “{query.trim()}”
              </span>
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
