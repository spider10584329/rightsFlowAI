"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchInputProps {
  /** Committed (debounced) value. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  "aria-label"?: string;
}

/** Text input that reports changes after the user stops typing. */
export function SearchInput({ value, onChange, placeholder = "Search…", debounceMs = 300, className, ...aria }: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Sync external changes (e.g. URL navigation) into the draft.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChangeRef.current(draft), debounceMs);
    return () => clearTimeout(timer);
  }, [draft, value, debounceMs]);

  return (
    <div className={cn("w-full sm:w-72", className)}>
      <Input
        type="search"
        role="searchbox"
        value={draft}
        placeholder={placeholder}
        aria-label={aria["aria-label"] ?? placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onChangeRef.current(draft);
          if (event.key === "Escape" && draft) {
            setDraft("");
            onChangeRef.current("");
          }
        }}
        leadingIcon={<Search aria-hidden />}
        className="[&::-webkit-search-cancel-button]:hidden"
        trailing={
          draft ? (
            <button
              type="button"
              aria-label="Clear search"
              className="inline-flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                setDraft("");
                onChangeRef.current("");
              }}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null
        }
      />
    </div>
  );
}
