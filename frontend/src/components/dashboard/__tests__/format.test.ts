import { describe, expect, it } from "vitest";

import {
  currencyOptions,
  entityHref,
  formatMoney,
  formatPercent,
  isZeroAmount,
  monthLabel,
  otherCurrenciesNote,
  resolveCurrency,
  toDisplayNumber,
  toMonthlyPoints,
  toRankedItems,
} from "@/components/dashboard/format";

describe("money display", () => {
  it("formats decimal strings with the currency code", () => {
    const text = formatMoney("1234.5", "USD");
    expect(text).toContain("USD");
    expect(text).toMatch(/1,234\.50/);
  });

  it("keeps negative adjustments and handles invalid input", () => {
    expect(formatMoney("-12.30", "EUR")).toMatch(/-.*12\.30|12\.30.*-/);
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney("abc", "USD")).toBe("—");
  });

  it("compacts large amounts", () => {
    expect(formatMoney("1250000", "USD", { compact: true })).toMatch(/1\.3M|1\.25M/);
    // Below 1,000 compact mode keeps the cents.
    expect(formatMoney("365.25", "USD", { compact: true })).toMatch(/365\.25/);
  });

  it("parses strings for display only", () => {
    expect(toDisplayNumber("150.50")).toBe(150.5);
    expect(toDisplayNumber("")).toBeNull();
    expect(isZeroAmount("0.00")).toBe(true);
    expect(isZeroAmount("0.01")).toBe(false);
    expect(formatPercent("42.50")).toBe("42.5%");
  });
});

describe("chart transforms", () => {
  it("maps monthly series to chart points keeping the exact amount", () => {
    const points = toMonthlyPoints([
      { month: "2026-01", amount: "10.00" },
      { month: "2026-02", amount: "0" },
    ]);
    expect(points).toEqual([
      { key: "2026-01", label: "Jan", longLabel: "Jan 2026", value: 10, amount: "10.00" },
      { key: "2026-02", label: "Feb", longLabel: "Feb 2026", value: 0, amount: "0" },
    ]);
    expect(monthLabel("bad")).toEqual({ short: "bad", long: "bad" });
  });

  it("scales ranked bars to the largest item and keeps backend order", () => {
    const items = toRankedItems(
      [
        { id: "a", amount: "50.00" },
        { id: "b", amount: "100.00" },
        { id: "c", amount: "-5.00" },
      ],
      (row) => ({ key: row.id, label: row.id, amount: row.amount }),
    );
    expect(items.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(items[0].share).toBe(50);
    expect(items[1].share).toBe(100);
    expect(items[2].share).toBe(0);
    expect(items[2].amount).toBe("-5.00");
  });

  it("returns zero widths when everything is zero", () => {
    const items = toRankedItems([{ amount: "0" }], () => ({ key: "x", label: "x", amount: "0" }));
    expect(items[0].share).toBe(0);
  });
});

describe("currency switcher", () => {
  it("puts the primary currency first and de-duplicates others", () => {
    expect(currencyOptions("USD", [{ currency: "GBP" }, { currency: "EUR" }], [{ currency: "EUR" }, { currency: "USD" }], undefined)).toEqual([
      "USD",
      "EUR",
      "GBP",
    ]);
  });

  it("falls back to primary for unknown or missing selections", () => {
    const options = ["USD", "EUR"];
    expect(resolveCurrency("eur", options, "USD")).toBe("EUR");
    expect(resolveCurrency("JPY", options, "USD")).toBe("USD");
    expect(resolveCurrency(null, options, "USD")).toBe("USD");
  });

  it("lists other currencies without converting and skips zero balances", () => {
    expect(otherCurrenciesNote([])).toBeNull();
    expect(otherCurrenciesNote([{ currency: "EUR", amount: "0.00" }])).toBeNull();
    const note = otherCurrenciesNote([
      { currency: "EUR", amount: "12.00" },
      { currency: "GBP", amount: "3.50" },
    ]);
    expect(note).toContain("EUR");
    expect(note).toContain("GBP");
    expect(note).toContain(" · ");
  });
});

describe("entityHref", () => {
  it("maps entity types to app routes", () => {
    expect(entityHref("work", "1")).toBe("/catalog/works/1");
    expect(entityHref("party", "2")).toBe("/catalog/parties/2");
    expect(entityHref("contract", "3")).toBe("/contracts/3");
    expect(entityHref("statement", "4")).toBe("/royalties/statements/4");
    expect(entityHref("unknown", "5")).toBeNull();
    expect(entityHref("work", null)).toBeNull();
  });
});
