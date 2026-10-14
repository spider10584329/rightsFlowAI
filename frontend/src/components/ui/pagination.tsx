"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
  disabled?: boolean;
}

function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const result: (number | "gap")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) result.push("gap");
  for (let value = start; value <= end; value += 1) result.push(value);
  if (end < pages - 1) result.push("gap");
  result.push(pages);
  return result;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  className,
  disabled,
}: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex flex-col gap-3 px-5 py-3 text-[13px] text-fg-muted sm:flex-row sm:items-center sm:justify-between", className)}
    >
      <div className="flex items-center gap-3">
        <p aria-live="polite">
          {total === 0 ? (
            "No results"
          ) : (
            <>
              Showing <span className="font-medium text-fg tabular-nums">{from.toLocaleString()}</span>–
              <span className="font-medium text-fg tabular-nums">{to.toLocaleString()}</span> of{" "}
              <span className="font-medium text-fg tabular-nums">{total.toLocaleString()}</span>
            </>
          )}
        </p>
        {onPageSizeChange ? (
          <div className="flex items-center gap-2">
            <span className="hidden text-fg-subtle sm:inline">Rows</span>
            <Select
              size="sm"
              className="w-[4.5rem]"
              aria-label="Rows per page"
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange(Number(value))}
              options={pageSizeOptions.map((option) => ({ value: String(option), label: String(option) }))}
              disabled={disabled}
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <IconButton
          label="Previous page"
          icon={<ChevronLeft aria-hidden />}
          size="sm"
          variant="outline"
          disabled={disabled || current <= 1}
          onClick={() => onPageChange(current - 1)}
        />
        <ul className="hidden items-center gap-1 sm:flex">
          {pageWindow(current, pages).map((item, index) =>
            item === "gap" ? (
              <li key={`gap-${index}`} className="px-1 text-fg-subtle" aria-hidden>
                …
              </li>
            ) : (
              <li key={item}>
                <button
                  type="button"
                  onClick={() => onPageChange(item)}
                  disabled={disabled}
                  aria-current={item === current ? "page" : undefined}
                  aria-label={`Page ${item}`}
                  className={cn(
                    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[13px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    item === current ? "bg-primary-soft font-semibold text-primary-soft-fg" : "hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {item}
                </button>
              </li>
            ),
          )}
        </ul>
        <span className="px-2 tabular-nums sm:hidden">
          {current} / {pages}
        </span>
        <IconButton
          label="Next page"
          icon={<ChevronRight aria-hidden />}
          size="sm"
          variant="outline"
          disabled={disabled || current >= pages}
          onClick={() => onPageChange(current + 1)}
        />
      </div>
    </nav>
  );
}
