import { describe, expect, it } from "vitest";

import { emptyLine, manualLinesTotal, mapManualApiErrors, toLinePayload, validateManualLines, type ManualLineDraft } from "@/components/royalties/manual-lines";
import { ApiError } from "@/lib/api/errors";

const line = (patch: Partial<ManualLineDraft>): ManualLineDraft => ({ ...emptyLine(), ...patch });

describe("manualLinesTotal", () => {
  it("sums exactly, including negatives and sub-cent amounts", () => {
    const lines = [line({ amount: "0.1" }), line({ amount: "0.2" }), line({ amount: "-0.00000001" }), line({ amount: "1,000.50" })];
    expect(manualLinesTotal(lines)).toEqual({ total: "1000.79999999", counted: 4, skipped: 0 });
  });

  it("handles totals beyond float precision", () => {
    const lines = [line({ amount: "999999999999.99999999" }), line({ amount: "0.00000001" })];
    expect(manualLinesTotal(lines).total).toBe("1000000000000.00000000");
  });

  it("skips empty or invalid amounts and reports how many", () => {
    const lines = [line({ amount: "12.5" }), line({ amount: "" }), line({ amount: "abc" }), line({ amount: "+3" })];
    expect(manualLinesTotal(lines)).toEqual({ total: "15.5", counted: 2, skipped: 2 });
  });
});

describe("validateManualLines", () => {
  it("requires a valid amount on every line and allows negatives", () => {
    const result = validateManualLines([line({ amount: "-25.00", title: "Refund" }), line({ amount: "" }), line({ amount: "1.123456789" })]);
    expect(result.valid).toBe(false);
    expect(result.rows[0]).toEqual({});
    expect(result.rows[1].amount).toBe("Enter an amount");
    expect(result.rows[2].amount).toBe("Use at most 8 decimal places");
  });

  it("checks identifier formats and lengths", () => {
    const result = validateManualLines([line({ amount: "1", isrc: "NOT-AN-ISRC", description: "x".repeat(256) })]);
    expect(result.rows[0].isrc).toMatch(/ISRC/);
    expect(result.rows[0].description).toMatch(/255/);
    expect(validateManualLines([line({ amount: "1", isrc: "QZSAM2600001" })]).valid).toBe(true);
    expect(validateManualLines([line({ amount: "1", isrc: "QZ-SAM-26-00001" })]).valid).toBe(true);
  });

  it("flags lines with no identifier as unmatched (non-blocking) and needs at least one line", () => {
    const result = validateManualLines([line({ amount: "5" }), line({ amount: "5", title: "Song" })]);
    expect(result.valid).toBe(true);
    expect(result.unidentified).toEqual([0]);
    expect(validateManualLines([]).errors[0]).toMatch(/at least one line/);
  });
});

describe("toLinePayload", () => {
  it("sends only filled fields, normalized amounts and the picked target", () => {
    const payload = toLinePayload(line({ amount: " +1,250.50 ", title: " Song ", isrc: "qzsam2600001", territory: "US", target: { kind: "work", id: "w1", title: "Song" } }));
    expect(payload).toEqual({ amount: "1250.50", title: "Song", isrc: "QZSAM2600001", territory: "US", work_id: "w1" });
  });
});

describe("mapManualApiErrors", () => {
  it("maps 422 loc paths to rows and metadata fields", () => {
    const error = new ApiError({
      status: 422,
      code: "validation_failed",
      message: "Request validation failed",
      details: [
        { loc: ["body", "lines", 1, "amount"], message: "Decimal input should have no more than 8 decimal places", type: "decimal_max_places" },
        { loc: ["body", "lines", 0, "recording_id"], message: "Too long", type: "string_too_long" },
        { loc: ["body", "period_end"], message: "Invalid date", type: "date_parsing" },
      ],
    });
    const mapped = mapManualApiErrors(error);
    expect(mapped.rows[1].amount).toMatch(/8 decimal places/);
    expect(mapped.rows[0].target).toBe("Too long");
    expect(mapped.fields.period_end).toBe("Invalid date");
  });

  it("maps service messages that name a 1-based line", () => {
    const error = new ApiError({ status: 422, code: "validation_failed", message: "Line 3: unknown territory 'XX'" });
    expect(mapManualApiErrors(error).rows[2]).toEqual({ territory: "unknown territory 'XX'" });
  });
});
