import { reasonInfo } from "@/components/royalties/labels";
import { addDecimals } from "@/components/royalties/money";
import type { RunSummaryRow, SummaryGroupBy } from "@/lib/api/hooks/royalties";
import { titleCase } from "@/lib/utils";

export interface PivotRow {
  key: string;
  label: string;
  currency: string;
  payable: string;
  retained: string;
  unallocated: string;
  total: string;
  count: number;
}

/** Pivots summary rows into one row per group and currency, summing exactly. */
export function pivotSummary(rows: RunSummaryRow[], groupBy: SummaryGroupBy): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const row of rows) {
    const label =
      groupBy === "reason"
        ? row.key
          ? reasonInfo(row.key).label
          : "Payable (no hold reason)"
        : groupBy === "rights_type"
          ? row.key
            ? titleCase(row.key)
            : "Not resolved"
          : (row.label ?? "No party (held)");
    const id = `${row.key ?? "none"}|${row.currency}`;
    const current = map.get(id) ?? { key: id, label, currency: row.currency, payable: "0", retained: "0", unallocated: "0", total: "0", count: 0 };
    if (row.allocation_type === "payable" || row.allocation_type === "retained" || row.allocation_type === "unallocated") {
      current[row.allocation_type] = addDecimals(current[row.allocation_type], row.amount);
    }
    current.total = addDecimals(current.total, row.amount);
    current.count += row.count;
    map.set(id, current);
  }
  return [...map.values()];
}
