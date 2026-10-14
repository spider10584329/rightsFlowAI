import { describe, expect, it } from "vitest";

import { emptyRow, rowsSignature, toEntry, validateRows, type SplitRow } from "../splits-editor";

const filled = (patch: Partial<SplitRow> = {}): SplitRow => ({
  ...emptyRow(),
  party: { id: "p1", label: "Ada" },
  share_percent: "50",
  ...patch,
});

describe("splits editor rows", () => {
  it("accepts a valid row", () => {
    expect(validateRows([filled()])).toEqual({});
  });

  it("flags missing party, bad percentages, territories and dates", () => {
    const rows = [
      filled({ party: null }),
      filled({ share_percent: "0" }),
      filled({ share_percent: "100.5" }),
      filled({ share_percent: "1.1234567" }),
      filled({ territories: [] }),
      filled({ effective_from: "2025-02-01", effective_to: "2025-01-01" }),
    ];
    const errors = validateRows(rows);
    expect(errors[rows[0].key].party).toBeDefined();
    expect(errors[rows[1].key].share_percent).toMatch(/above 0/);
    expect(errors[rows[2].key].share_percent).toMatch(/at most 100/);
    expect(errors[rows[3].key].share_percent).toMatch(/6 decimals/);
    expect(errors[rows[4].key].territories).toBeDefined();
    expect(errors[rows[5].key].effective_to).toBeDefined();
  });

  it("builds the API entry with nulls for empty optional fields", () => {
    const entry = toEntry(filled({ share_percent: " 33.5 ", contract: { id: "c1", label: "Deal" }, excluded_territories: ["US"] }));
    expect(entry).toEqual({
      party_id: "p1",
      role: "writer",
      share_percent: "33.5",
      territories: ["WORLD"],
      excluded_territories: ["US"],
      effective_from: null,
      effective_to: null,
      is_controlled: true,
      contract_id: "c1",
      notes: null,
    });
    expect(toEntry(filled()).excluded_territories).toBeNull();
  });

  it("signature ignores row keys but tracks edits", () => {
    const a = filled();
    const b = { ...a, key: "other" };
    expect(rowsSignature([a])).toBe(rowsSignature([b]));
    expect(rowsSignature([a])).not.toBe(rowsSignature([{ ...a, share_percent: "51" }]));
  });
});
