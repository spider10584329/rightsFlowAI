"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatMoney } from "@/components/royalties/money";

interface Datum {
  label: string;
  /** Exact decimal string; converted to a number only for bar length. */
  value: string;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Single-series horizontal bar chart (one hue, no legend; the table below is the accessible view). */
export function ReportChart({ data, currency }: { data: Datum[]; currency: string }) {
  const rows = data.map((d) => ({ label: d.label.length > 28 ? `${d.label.slice(0, 27)}…` : d.label, fullLabel: d.label, exact: d.value, plot: Number(d.value) }));
  const height = Math.max(160, rows.length * 34 + 40);
  return (
    <div className="px-2 pb-4 pt-2" role="img" aria-label={`Bar chart of the top ${rows.length} rows in ${currency}. The same values are listed in the table below.`}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 4" />
          <XAxis type="number" tickFormatter={(v: number) => compact.format(v)} tick={{ fill: "var(--fg-subtle)", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={170} tick={{ fill: "var(--fg-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload }) => {
              const item = active && payload && payload.length > 0 ? (payload[0].payload as (typeof rows)[number]) : null;
              if (!item) return null;
              return (
                <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
                  <p className="font-medium text-fg">{item.fullLabel}</p>
                  <p className="tabular-nums text-fg-muted">{formatMoney(item.exact, currency, { precision: "exact" })}</p>
                </div>
              );
            }}
          />
          <Bar dataKey="plot" fill="var(--primary)" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
