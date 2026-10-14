"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import { LegendItem, SERIES_COLORS } from "@/components/dashboard/chart-card";
import { formatCompact, formatCount, formatMoney, type MoneyPoint, type RankedItem } from "@/components/dashboard/format";
import { cn } from "@/lib/utils";

const AXIS_TICK = { fill: "var(--fg-subtle)", fontSize: 11 };

interface TooltipRow {
  key: string;
  color: string;
  label: string;
  value: string;
}

/** Tooltip body: values lead, series names follow, keyed by a short line in the series color. */
function TooltipBox({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="min-w-36 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-fg-muted">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-semibold text-fg tabular-nums">{row.value}</span>
            <span className="text-fg-subtle">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ChartTooltipProps = TooltipContentProps<ValueType, NameType>;

/** The data row under the pointer (recharts types `payload` loosely). */
function hoveredRow<T>(props: ChartTooltipProps): T | undefined {
  if (!props.active) return undefined;
  return props.payload?.[0]?.payload as T | undefined;
}

/** Monthly reported royalties as columns (one series, slot 1). */
export function MonthlyColumns({ points, currency, seriesLabel }: { points: MoneyPoint[]; currency: string; seriesLabel: string }) {
  return (
    <div className="h-64 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tick={AXIS_TICK} interval="preserveStartEnd" />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            width={52}
            tickFormatter={(value: number) => formatCompact(value)}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            isAnimationActive={false}
            content={(props: ChartTooltipProps) => {
              const point = hoveredRow<MoneyPoint>(props);
              if (!point) return null;
              return (
                <TooltipBox
                  title={point.longLabel}
                  rows={[{ key: "amount", color: SERIES_COLORS[0], label: seriesLabel, value: formatMoney(point.amount, currency) }]}
                />
              );
            }}
          />
          <Bar dataKey="value" fill={SERIES_COLORS[0]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface LineSeries {
  key: string;
  label: string;
}

/** Multi-series line chart (<= 3 series, fixed slot order) with a shared crosshair tooltip. */
export function MultiLineChart<T extends { label: string; longLabel: string }>({
  data,
  series,
  formatValue = formatCount,
}: {
  data: T[];
  series: LineSeries[];
  formatValue?: (value: number) => string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1" aria-hidden>
        {series.map((entry, index) => (
          <LegendItem key={entry.key} color={SERIES_COLORS[index]} label={entry.label} shape="line" />
        ))}
      </div>
      <div className="h-60 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} tick={AXIS_TICK} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} width={44} allowDecimals={false} tickFormatter={(value: number) => formatCompact(value)} />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(props: ChartTooltipProps) => {
                const point = hoveredRow<T>(props);
                if (!point) return null;
                const record = point as unknown as Record<string, number>;
                return (
                  <TooltipBox
                    title={point.longLabel}
                    rows={series.map((entry, index) => ({
                      key: entry.key,
                      color: SERIES_COLORS[index],
                      label: entry.label,
                      value: formatValue(record[entry.key] ?? 0),
                    }))}
                  />
                );
              }}
            />
            {series.map((entry, index) => (
              <Line
                key={entry.key}
                type="linear"
                dataKey={entry.key}
                stroke={SERIES_COLORS[index]}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Ranked horizontal bars in HTML: label + value at the bar tip, one hue
 * (single series), bars scaled to the largest value.
 */
export function RankedBars({
  items,
  formatValue,
  max = 8,
  moreHint,
}: {
  items: RankedItem[];
  formatValue: (item: RankedItem) => string;
  max?: number;
  moreHint?: (hidden: number) => ReactNode;
}) {
  const visible = items.slice(0, max);
  const hidden = items.length - visible.length;
  return (
    <div>
      <ol className="space-y-3">
        {visible.map((item) => (
          <li key={item.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">
                {item.href ? (
                  <Link href={item.href} className="font-medium text-fg hover:text-primary hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span className="font-medium text-fg">{item.label}</span>
                )}
                {item.sublabel ? <span className="ml-2 text-xs text-fg-subtle">{item.sublabel}</span> : null}
              </span>
              <span className="shrink-0 font-medium text-fg tabular-nums">{formatValue(item)}</span>
            </div>
            <div className="mt-1.5 h-2 w-full rounded-full bg-surface-2" aria-hidden>
              <div className="h-2 rounded-r-[4px] rounded-l-full" style={{ width: `${Math.max(item.share, item.value > 0 ? 1 : 0)}%`, backgroundColor: SERIES_COLORS[0] }} />
            </div>
          </li>
        ))}
      </ol>
      {hidden > 0 && moreHint ? <p className="mt-3 text-xs text-fg-subtle">{moreHint(hidden)}</p> : null}
    </div>
  );
}

/** Two-part stacked bar per row (e.g. controlled vs non-controlled shares). */
export function SplitBars({
  rows,
  labels,
}: {
  rows: { key: string; label: string; first: number; second: number }[];
  labels: [string, string];
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <LegendItem color={SERIES_COLORS[0]} label={labels[0]} />
        <LegendItem color={SERIES_COLORS[1]} label={labels[1]} />
      </div>
      <ul className="space-y-3">
        {rows.map((row) => {
          const total = row.first + row.second;
          const firstPct = total > 0 ? (row.first / total) * 100 : 0;
          return (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="font-medium text-fg">{row.label}</span>
                <span className="text-xs text-fg-muted tabular-nums">
                  {formatCount(row.first)} {labels[0].toLowerCase()} · {formatCount(row.second)} {labels[1].toLowerCase()}
                </span>
              </div>
              <div className="mt-1.5 flex h-2.5 w-full gap-[2px] overflow-hidden rounded" aria-hidden>
                {row.first > 0 ? <div className={cn("h-full", row.second > 0 ? "rounded-l" : "rounded")} style={{ width: `${firstPct}%`, backgroundColor: SERIES_COLORS[0] }} /> : null}
                {row.second > 0 ? <div className={cn("h-full flex-1", row.first > 0 ? "rounded-r" : "rounded")} style={{ backgroundColor: SERIES_COLORS[1] }} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
