import { describe, expect, it } from "vitest";

import {
  addDecimals,
  compareDecimals,
  decimalSign,
  formatDecimal,
  formatMoney,
  formatPercent,
  negateDecimal,
  parseDecimal,
  subtractDecimals,
  totalsByCurrency,
  trimDecimal,
  validateAmount,
} from "@/components/royalties/money";

describe("exact decimal arithmetic", () => {
  it("adds without floating point error", () => {
    // 0.1 + 0.2 === 0.30000000000000004 with floats.
    expect(addDecimals("0.1", "0.2")).toBe("0.3");
    expect(addDecimals("0.10000000", "0.20000000")).toBe("0.30000000");
  });

  it("keeps 8 decimal places of sub-cent allocations exact", () => {
    expect(addDecimals("33.33333333", "33.33333333", "33.33333334")).toBe("100.00000000");
  });

  it("handles values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(addDecimals("9007199254740993.00000001", "1")).toBe("9007199254740994.00000001");
    expect(subtractDecimals("12345678901234567890.12345678", "0.00000001")).toBe("12345678901234567890.12345677");
  });

  it("handles negatives, nulls and mixed scales", () => {
    expect(addDecimals("-12.50", "2.5", null, undefined, "")).toBe("-10.00");
    expect(subtractDecimals("0", "0.00000001")).toBe("-0.00000001");
    expect(negateDecimal("-4.20")).toBe("4.20");
    expect(addDecimals()).toBe("0");
  });

  it("reconciles a run's totals exactly", () => {
    const input = "71.41000000";
    const total = addDecimals("48.00000000", "11.25000000", "12.16000000");
    expect(compareDecimals(total, input)).toBe(0);
  });

  it("compares and signs exactly", () => {
    expect(compareDecimals("0.30000000", "0.3")).toBe(0);
    expect(compareDecimals("0.00000001", "0")).toBe(1);
    expect(compareDecimals("-1", "-0.99999999")).toBe(-1);
    expect(decimalSign("-0.00")).toBe(0);
    expect(decimalSign("-0.01")).toBe(-1);
  });

  it("rejects non-decimal strings", () => {
    expect(parseDecimal("1,234.00")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("1e5")).toBeNull();
    expect(() => addDecimals("1e5")).toThrow();
  });

  it("trims insignificant zeros", () => {
    expect(trimDecimal("12.50000000")).toBe("12.5");
    expect(trimDecimal("3.00")).toBe("3");
    expect(trimDecimal("-0.000")).toBe("0");
  });

  it("totals per currency without floats", () => {
    const rows = [
      { amount: "0.1", currency: "USD" },
      { amount: "0.2", currency: "USD" },
      { amount: "5.55", currency: "EUR" },
    ];
    expect(totalsByCurrency(rows, (r) => r.amount, (r) => r.currency)).toEqual([
      ["EUR", "5.55"],
      ["USD", "0.3"],
    ]);
  });
});

describe("money display", () => {
  it("formats with the currency's minor unit by default", () => {
    expect(formatMoney("1234.5", "USD", { locale: "en-US" })).toBe("$1,234.50");
    expect(formatMoney("-12.25000000", "EUR", { locale: "en-US" })).toBe("-€12.25");
  });

  it("shows sub-cent precision when exact", () => {
    expect(formatMoney("0.33333333", "USD", { locale: "en-US", precision: "exact" })).toBe("$0.33333333");
    expect(formatMoney("12.50000000", "USD", { locale: "en-US", precision: "exact" })).toBe("$12.50");
  });

  it("formats huge values from the string, not a float", () => {
    expect(formatMoney("12345678901234567.89", "USD", { locale: "en-US" })).toBe("$12,345,678,901,234,567.89");
  });

  it("supports explicit signs and ISO codes", () => {
    expect(formatMoney("5", "USD", { locale: "en-US", signDisplay: "always" })).toBe("+$5.00");
    expect(formatMoney("5", "USD", { locale: "en-US", currencyDisplay: "code" })).toMatch(/USD\s?5\.00/);
  });

  it("falls back for unknown currencies and missing values", () => {
    expect(formatMoney("10", "XX", { locale: "en-US" })).toBe("10.00 XX");
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("formats decimals and percentages", () => {
    expect(formatDecimal("1234567.5", { locale: "en-US" })).toBe("1,234,567.5");
    expect(formatPercent("50.0000")).toBe("50%");
    expect(formatPercent("33.33333333")).toMatch(/33[.,]33333333%/);
  });
});

describe("amount input validation", () => {
  it("accepts valid amounts", () => {
    expect(validateAmount("1250.00")).toBeNull();
    expect(validateAmount("1,250.5", { maxDecimals: 2 })).toBeNull();
    expect(validateAmount("-10", { allowNegative: true })).toBeNull();
  });

  it("enforces backend rules", () => {
    expect(validateAmount("")).toBe("Enter an amount");
    expect(validateAmount("", { required: false })).toBeNull();
    expect(validateAmount("abc")).toMatch(/number/);
    expect(validateAmount("1.234", { maxDecimals: 2 })).toBe("Use at most 2 decimal places");
    expect(validateAmount("-5")).toBe("Amount must be positive");
    expect(validateAmount("0")).toBe("Amount must not be zero");
    expect(validateAmount("0", { allowZero: true })).toBeNull();
    expect(validateAmount("1234567890123", { maxDecimals: 8, maxDigits: 20 })).toBe("Amount is too large");
  });
});
