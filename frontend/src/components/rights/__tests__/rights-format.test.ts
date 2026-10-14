import { describe, expect, it } from "vitest";

import {
  conflictActionNeedsNotes,
  conflictActionsFor,
  DEFAULT_RULE,
  describeValidation,
  issueSummary,
  microToPercentString,
  parsePercent,
  resolveRule,
  runningTotal,
  sumPercents,
  totalStatus,
  trimPercent,
} from "../rights-format";

const row = (share_percent: string, extra: Partial<{ territories: string[]; effective_from: string }> = {}) => ({
  share_percent,
  territories: extra.territories ?? ["WORLD"],
  excluded_territories: [],
  effective_from: extra.effective_from ?? "",
  effective_to: "",
});

describe("exact percentages", () => {
  it("parses decimal strings into micro-units and rejects bad input", () => {
    expect(parsePercent("100")).toBe(BigInt(100_000_000));
    expect(parsePercent("33.333333")).toBe(BigInt(33_333_333));
    expect(parsePercent(".5")).toBe(BigInt(500_000));
    expect(parsePercent("1.1234567")).toBeNull();
    expect(parsePercent("-1")).toBeNull();
    expect(parsePercent("abc")).toBeNull();
    expect(parsePercent("")).toBeNull();
  });

  it("sums without floating point drift", () => {
    const { total, invalid } = sumPercents(["33.333333", "33.333333", "33.333334"]);
    expect(invalid).toBe(0);
    expect(microToPercentString(total)).toBe("100");
    // 0.1 + 0.2 is exact here (would be 0.30000000000000004 with floats)
    expect(microToPercentString(sumPercents(["0.1", "0.2"]).total)).toBe("0.3");
  });

  it("counts invalid entries instead of adding them", () => {
    expect(sumPercents(["50", "x", ""]).invalid).toBe(2);
  });

  it("trims backend decimals for editing", () => {
    expect(trimPercent("50.500000")).toBe("50.5");
    expect(trimPercent("100.000000")).toBe("100");
    expect(trimPercent("100")).toBe("100");
  });
});

describe("split totals", () => {
  it("compares against the rule with tolerance like the backend", () => {
    expect(totalStatus(parsePercent("100.005")!, DEFAULT_RULE)).toBe("ok");
    expect(totalStatus(parsePercent("100.02")!, DEFAULT_RULE)).toBe("over");
    expect(totalStatus(parsePercent("90")!, DEFAULT_RULE)).toBe("under");
    expect(totalStatus(parsePercent("90")!, { ...DEFAULT_RULE, allowUnderAllocation: true })).toBe("under_allowed");
  });

  it("reports a live running total with remaining share", () => {
    const total = runningTotal([row("60"), row("25.5")]);
    expect(total.totalLabel).toBe("85.5");
    expect(total.remaining).toBe("14.5");
    expect(total.status).toBe("under");
    expect(total.uniformScope).toBe(true);
  });

  it("flags over-allocation and negative remaining", () => {
    const total = runningTotal([row("60"), row("50")]);
    expect(total.status).toBe("over");
    expect(total.remaining).toBe("-10");
  });

  it("marks mixed scopes as indicative and invalid values as invalid", () => {
    expect(runningTotal([row("50"), row("50", { territories: ["US"] })]).uniformScope).toBe(false);
    expect(runningTotal([row("50"), row("50", { effective_from: "2024-01-01" })]).uniformScope).toBe(false);
    expect(runningTotal([row("50"), row("oops")]).status).toBe("invalid");
  });

  it("resolves the most specific split rule", () => {
    const base = { tolerance: "0.01", allow_under_allocation: false, enforcement: "warn" };
    const rules = [
      { ...base, id: "all", asset_type: "work", rights_type: "performance", territory: null, expected_total: "100" },
      { ...base, id: "world", asset_type: "work", rights_type: "performance", territory: "WORLD", expected_total: "100", enforcement: "block" },
      { ...base, id: "us", asset_type: "work", rights_type: "performance", territory: "US", expected_total: "50" },
      { ...base, id: "rec", asset_type: "recording", rights_type: "master", territory: null, expected_total: "100" },
    ];
    expect(resolveRule(rules, "work", "performance", "US").ruleId).toBe("us");
    expect(resolveRule(rules, "work", "performance", "GB").ruleId).toBe("world");
    expect(resolveRule(rules, "work", "performance", "WORLD").enforcement).toBe("block");
    expect(resolveRule(rules.filter((r) => r.id !== "world"), "work", "performance", "GB").ruleId).toBe("all");
    expect(resolveRule(rules, "work", "mechanical", "US")).toBe(DEFAULT_RULE);
  });
});

describe("validation display", () => {
  const issue = (blocking: boolean) => ({
    type: "over_allocation",
    severity: "critical",
    blocking,
    enforcement: blocking ? "block" : "warn",
    rights_type: "performance",
    title: "Performance over-allocated at 110%",
    message: "…",
    share_ids: [],
    details: {},
  });

  it("blocks saving when any issue is blocking", () => {
    const display = describeValidation({ valid: false, blocked: true, issues: [issue(true), issue(false)] });
    expect(display.tone).toBe("danger");
    expect(display.canSave).toBe(false);
    expect(display.blocking).toHaveLength(1);
    expect(display.warnings).toHaveLength(1);
  });

  it("allows saving with warnings", () => {
    const display = describeValidation({ valid: false, blocked: false, issues: [issue(false)] });
    expect(display.tone).toBe("warning");
    expect(display.canSave).toBe(true);
    expect(display.headline).toMatch(/you can still save/);
  });

  it("is green when there are no issues", () => {
    expect(describeValidation({ valid: true, blocked: false, issues: [] }).tone).toBe("success");
  });

  it("summarises an issue in plain language", () => {
    expect(issueSummary(issue(true))).toBe("Blocks saving · Over-allocation: Performance over-allocated at 110%");
    expect(issueSummary(issue(false))).toMatch(/^Warning/);
  });
});

describe("conflict lifecycle", () => {
  it("mirrors the backend transitions", () => {
    expect(conflictActionsFor("open")).toEqual(["acknowledge", "resolve", "dismiss"]);
    expect(conflictActionsFor("acknowledged")).toEqual(["resolve", "dismiss", "reopen"]);
    expect(conflictActionsFor("resolved")).toEqual(["reopen"]);
    expect(conflictActionsFor("dismissed")).toEqual(["reopen"]);
  });

  it("requires notes to resolve or dismiss", () => {
    expect(conflictActionNeedsNotes("resolve")).toBe(true);
    expect(conflictActionNeedsNotes("dismiss")).toBe(true);
    expect(conflictActionNeedsNotes("acknowledge")).toBe(false);
    expect(conflictActionNeedsNotes("reopen")).toBe(false);
  });
});
