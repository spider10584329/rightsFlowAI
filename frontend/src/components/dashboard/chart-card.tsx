"use client";

import { BarChart3, Table2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Chart palette (validated with the dataviz validator against this app's
 * surfaces: light #ffffff, dark #11141f). Slots are assigned in fixed order
 * and follow the entity, never its rank. Dark steps are selected, not flipped.
 * Text never wears these colors; they are only for marks.
 */
export const VIZ_VARS =
  "[--viz-1:#2a78d6] [--viz-2:#eb6834] [--viz-3:#1baf7a] dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926] dark:[--viz-3:#199e70]";

export const SERIES_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"] as const;

export type ChartView = "chart" | "table";

export interface ChartCardProps {
  title: string;
  description?: ReactNode;
  /** Plain-language text alternative, always rendered (and read by screen readers). */
  summary?: string | null;
  /** The accessible table view of the same data. */
  table?: ReactNode;
  children?: ReactNode;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  isEmpty?: boolean;
  empty?: ReactNode;
  footnote?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Skeleton height while loading. */
  skeletonClassName?: string;
}

/** Card with a chart/table toggle, a text summary, and loading/error/empty states. */
export function ChartCard({
  title,
  description,
  summary,
  table,
  children,
  isLoading,
  isFetching,
  error,
  onRetry,
  isEmpty,
  empty,
  footnote,
  actions,
  className,
  skeletonClassName = "h-56",
}: ChartCardProps) {
  const [view, setView] = useState<ChartView>("chart");
  const headingId = useId();
  const hasData = !isLoading && !error && !isEmpty;

  return (
    <Card className={cn("flex min-w-0 flex-col", VIZ_VARS, className)} role="region" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 space-y-0.5">
          <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-fg">
            {title}
          </h2>
          {description ? <p className="text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {table && hasData ? <ViewToggle view={view} onChange={setView} label={title} /> : null}
        </div>
      </div>
      <div className={cn("flex-1 px-5 py-4", isFetching && !isLoading && "opacity-70 transition-opacity")} aria-busy={isLoading || isFetching || undefined}>
        {isLoading ? (
          <div role="status" aria-label={`Loading ${title}`}>
            <Skeleton className={cn("w-full", skeletonClassName)} />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} compact />
        ) : isEmpty ? (
          empty
        ) : (
          <>
            {summary ? <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">{summary}</p> : null}
            {view === "table" && table ? <div className="overflow-x-auto">{table}</div> : children}
          </>
        )}
      </div>
      {footnote && hasData ? <div className="border-t border-border px-5 py-2.5 text-xs leading-relaxed text-fg-subtle">{footnote}</div> : null}
    </Card>
  );
}

function ViewToggle({ view, onChange, label }: { view: ChartView; onChange: (view: ChartView) => void; label: string }) {
  const options: { value: ChartView; text: string; icon: ReactNode }[] = [
    { value: "chart", text: "Chart", icon: <BarChart3 aria-hidden /> },
    { value: "table", text: "Table", icon: <Table2 aria-hidden /> },
  ];
  return (
    <div role="group" aria-label={`${label} view`} className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5",
            view === option.value && "bg-surface text-fg shadow-xs",
          )}
        >
          {option.icon}
          {option.text}
        </button>
      ))}
    </div>
  );
}

/** Simple accessible data table used by every chart's table view. */
export function DataGrid({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: { key: string; header: string; align?: "left" | "right" }[];
  rows: { key: string; cells: Record<string, ReactNode> }[];
}) {
  return (
    <table className="w-full min-w-[22rem] text-[13px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border text-2xs uppercase tracking-[0.06em] text-fg-subtle">
          {columns.map((column) => (
            <th key={column.key} scope="col" className={cn("px-2 py-2 font-semibold", column.align === "right" ? "text-right" : "text-left")}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.key}>
            {columns.map((column, index) =>
              index === 0 ? (
                <th key={column.key} scope="row" className="px-2 py-2 text-left font-medium text-fg">
                  {row.cells[column.key]}
                </th>
              ) : (
                <td key={column.key} className={cn("px-2 py-2 text-fg-muted tabular-nums", column.align === "right" ? "text-right" : "text-left")}>
                  {row.cells[column.key]}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Legend entry: a colored key beside text-token ink (text never wears the series color). */
export function LegendItem({ color, label, shape = "rect" }: { color: string; label: ReactNode; shape?: "rect" | "line" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <span
        aria-hidden
        className={cn("inline-block", shape === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-[3px]")}
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
