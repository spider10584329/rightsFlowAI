import { describe, expect, it } from "vitest";

import { applySuggestions, cleanMapping, orderedFields, validateMapping } from "@/components/royalties/mapping";

const HEADERS = ["Store", "Artist", "Title", "ISRC", "UPC", "Country of Sale", "Quantity", "Earnings (USD)", "Sale Month"];

describe("validateMapping", () => {
  it("accepts amount plus an identifier", () => {
    const result = validateMapping({ amount: "Earnings (USD)", isrc: "ISRC", title: "Title" }, HEADERS);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires the amount column", () => {
    const result = validateMapping({ isrc: "ISRC" }, HEADERS);
    expect(result.valid).toBe(false);
    expect(result.fieldErrors.amount).toMatch(/required/);
  });

  it("requires at least one identifying column", () => {
    const result = validateMapping({ amount: "Earnings (USD)", artist: "Artist" }, HEADERS);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/ISRC, ISWC, UPC or title/);
  });

  it("rejects columns that are not in the file and unknown fields", () => {
    const result = validateMapping({ amount: "Net", isrc: "ISRC", bogus: "Title" }, HEADERS, ["amount", "isrc", "title"]);
    expect(result.valid).toBe(false);
    expect(result.fieldErrors.amount).toMatch(/not in this file/);
    expect(result.fieldErrors.bogus).toBe("Unknown field");
  });

  it("ignores empty selections and warns about reused columns", () => {
    expect(cleanMapping({ amount: "Earnings (USD)", iswc: "", upc: "  " })).toEqual({ amount: "Earnings (USD)" });
    const result = validateMapping({ amount: "Earnings (USD)", gross_amount: "Earnings (USD)", title: "Title" }, HEADERS);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Earnings (USD)"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Only titles"))).toBe(true);
  });
});

describe("applySuggestions", () => {
  it("only applies suggestions that reference real columns", () => {
    const { mapping, applied, skipped } = applySuggestions({ amount: "Earnings (USD)" }, { isrc: "ISRC", territory: "Territory", amount: "Earnings (USD)" }, HEADERS);
    expect(mapping).toEqual({ amount: "Earnings (USD)", isrc: "ISRC" });
    expect(applied).toEqual(["isrc"]);
    expect(skipped).toEqual(["territory"]);
  });
});

describe("orderedFields", () => {
  it("puts amount and identifiers first", () => {
    expect(orderedFields(["store", "title", "zzz", "amount", "isrc"])).toEqual(["amount", "isrc", "title", "store", "zzz"]);
  });
});
