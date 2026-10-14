import { describe, expect, it } from "vitest";

import { affectsCalculation, buildStatementPatch, formFromStatement, validateStatementEdit } from "@/components/royalties/statement-edit";
import type { Statement } from "@/lib/api/hooks/royalties";

const statement = {
  id: "s1",
  source_name: "Distro",
  source_category: "distributor",
  default_rights_type: null,
  period_start: "2026-01-01",
  period_end: "2026-01-31",
  currency: "USD",
  reported_total: "10.00000000",
  notes: null,
} as unknown as Statement;

describe("statement edit form", () => {
  it("round-trips without producing a patch", () => {
    expect(buildStatementPatch(statement, formFromStatement(statement))).toEqual({});
  });

  it("treats equal decimals as unchanged and detects real changes", () => {
    const form = { ...formFromStatement(statement), reported_total: "10" };
    expect(buildStatementPatch(statement, form)).toEqual({});
    expect(buildStatementPatch(statement, { ...form, reported_total: "10.01" })).toEqual({ reported_total: "10.01" });
    expect(buildStatementPatch(statement, { ...form, reported_total: "1,250.50" })).toEqual({ reported_total: "1250.50" });
  });

  it("uses explicit clear flags for removed optional values", () => {
    const withRights = { ...statement, default_rights_type: "master" } as Statement;
    const patch = buildStatementPatch(withRights, { ...formFromStatement(withRights), default_rights_type: "", reported_total: "" });
    expect(patch).toEqual({ clear_default_rights_type: true, clear_reported_total: true });
    expect(affectsCalculation(patch)).toBe(true);
  });

  it("flags calculation inputs but not cosmetic fields", () => {
    expect(affectsCalculation(buildStatementPatch(statement, { ...formFromStatement(statement), source_name: "New" }))).toBe(false);
    expect(affectsCalculation(buildStatementPatch(statement, { ...formFromStatement(statement), period_end: "2026-02-28" }))).toBe(true);
  });

  it("validates periods, currency and amounts textually", () => {
    const errors = validateStatementEdit({
      ...formFromStatement(statement),
      source_name: " ",
      period_end: "2025-12-31",
      currency: "usd",
      reported_total: "1.123456789",
    });
    expect(Object.keys(errors).sort()).toEqual(["currency", "period_end", "reported_total", "source_name"]);
  });
});
