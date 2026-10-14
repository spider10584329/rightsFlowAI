import { describe, expect, it } from "vitest";

import { pivotSummary } from "@/components/royalties/summary";

describe("pivotSummary", () => {
  it("pivots allocation types per party and sums exactly", () => {
    const rows = pivotSummary(
      [
        { key: "p1", label: "Sample Artist", allocation_type: "payable", currency: "USD", amount: "33.14277777", count: 4 },
        { key: "p1", label: "Sample Artist", allocation_type: "retained", currency: "USD", amount: "0.00000001", count: 1 },
        { key: "p2", label: "Label", allocation_type: "retained", currency: "USD", amount: "40.43722222", count: 4 },
        { key: null, label: null, allocation_type: "unallocated", currency: "USD", amount: "0.16", count: 1 },
      ],
      "party",
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ label: "Sample Artist", payable: "33.14277777", retained: "0.00000001", total: "33.14277778", count: 5 });
    expect(rows[2]).toMatchObject({ label: "No party (held)", unallocated: "0.16", total: "0.16" });
  });

  it("labels reasons in plain language and keeps currencies apart", () => {
    const rows = pivotSummary(
      [
        { key: "missing_ownership", label: "missing_ownership", allocation_type: "unallocated", currency: "USD", amount: "1.00", count: 1 },
        { key: "missing_ownership", label: "missing_ownership", allocation_type: "unallocated", currency: "EUR", amount: "2.00", count: 1 },
        { key: null, label: null, allocation_type: "payable", currency: "USD", amount: "5", count: 2 },
      ],
      "reason",
    );
    expect(rows.map((r) => `${r.label}|${r.currency}|${r.total}`)).toEqual([
      "No ownership registered|USD|1.00",
      "No ownership registered|EUR|2.00",
      "Payable (no hold reason)|USD|5",
    ]);
  });
});
