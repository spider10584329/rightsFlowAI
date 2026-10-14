import { describe, expect, it } from "vitest";

import {
  automationAccess,
  canReleaseInstance,
  canRetryStatementState,
  errorCategoryLabel,
  expiryLevelStyle,
  formatAge,
  graceLabel,
  inboxErrorText,
  inboxStateTone,
  safeAppPath,
  shortInstanceId,
  statementMappingPath,
  statementStateLabel,
  statementStateTone,
  summarizeReviewTask,
} from "../automation-format";

describe("automationAccess (role gating)", () => {
  it("lets everyone read the queue, managers act on it and only admins manage automation", () => {
    expect(automationAccess("viewer")).toEqual({ viewQueue: true, actOnQueue: false, admin: false });
    expect(automationAccess("manager")).toEqual({ viewQueue: true, actOnQueue: true, admin: false });
    expect(automationAccess("admin")).toEqual({ viewQueue: true, actOnQueue: true, admin: true });
    expect(automationAccess("owner")).toEqual({ viewQueue: true, actOnQueue: true, admin: true });
    expect(automationAccess(null)).toEqual({ viewQueue: false, actOnQueue: false, admin: false });
  });
});

describe("summarizeReviewTask", () => {
  it("summarizes statement findings with counts and held reasons", () => {
    const summary = summarizeReviewTask({
      kind: "statement_review",
      details: {
        status: "calculated",
        lines: { valid: 120, invalid: 2, matched: 100, unmatched: 18, ignored: 0 },
        held: [
          { reason: "missing_ownership", count: 3 },
          { reason: "disputed_ownership", count: 1 },
        ],
        import_errors: 0,
        calculation_error: null,
        other_currencies: true,
      },
    });
    expect(summary.lines).toEqual([
      "18 unmatched lines",
      "2 invalid lines",
      "4 lines held for review: missing ownership (3), disputed ownership (1)",
      "Contains lines in other currencies",
      "Nothing has been posted",
    ]);
    expect(summary.aiNote).toBeNull();
  });

  it("reports failed imports and calculation errors", () => {
    const summary = summarizeReviewTask({
      kind: "statement_review",
      details: { status: "failed", lines: { unmatched: 1 }, held: [], import_errors: 1, calculation_error: "no_contract_terms" },
    });
    expect(summary.lines).toContain("The statement import failed");
    expect(summary.lines).toContain("1 unmatched line");
    expect(summary.lines).toContain("1 import error");
    expect(summary.lines).toContain("Calculation could not complete (no contract terms)");
  });

  it("explains column-mapping tasks", () => {
    const summary = summarizeReviewTask({
      kind: "statement_mapping",
      details: { status: "uploaded", adapter: "generic_csv", reason: "No amount column could be identified automatically" },
    });
    expect(summary.lines).toEqual(["No amount column could be identified automatically", "Format: generic csv"]);
  });

  it("flags AI metadata suggestions as pending approval", () => {
    const summary = summarizeReviewTask({
      kind: "ai_metadata",
      details: {
        outcome: "suggested",
        suggestion_ids: ["s1", "s2"],
        proposed_fields: ["genre", "release_date"],
        deterministic_issues: [{ code: "missing_iswc", severity: "warning", message: "ISWC is missing" }],
        ai_generated: true,
        note: "AI suggestions are pending human approval and change nothing until approved.",
      },
    });
    expect(summary.lines).toEqual(["2 AI suggestions for genre, release date", "1 validation issue: ISWC is missing"]);
    expect(summary.aiNote).toBe("AI-generated, pending approval");
    expect(summary.note).toMatch(/pending human approval/);
  });

  it("does not claim AI output when the provider was unavailable", () => {
    const summary = summarizeReviewTask({
      kind: "ai_metadata",
      details: { outcome: "ai_unavailable", suggestion_ids: [], proposed_fields: [], deterministic_issues: [{ message: "Title is empty" }], ai_generated: false },
    });
    expect(summary.aiNote).toBeNull();
    expect(summary.lines).toEqual(["1 validation issue: Title is empty", "AI is not available on this plan or server"]);
  });

  it("summarizes conflict reviews as advisory", () => {
    const summary = summarizeReviewTask({
      kind: "ai_conflict",
      details: {
        conflict_type: "over_allocation",
        severity: "high",
        system_explanation: "Shares total 120%.",
        ai_generated: true,
        ai_summary: "Two publishers both claim 60%.",
        suggested_next_steps: ["Check the contracts", "Contact the co-publisher"],
        outcome: "explained",
      },
    });
    expect(summary.lines).toEqual(["Over Allocation · high severity", "Two publishers both claim 60%.", "2 suggested next steps"]);
    expect(summary.aiNote).toBe("AI-generated, advisory only");
  });

  it("tolerates missing or malformed details", () => {
    expect(summarizeReviewTask({ kind: "ai_conflict", details: null })).toEqual({ lines: [], aiNote: null, note: null });
    expect(summarizeReviewTask({ kind: "statement_review", details: { lines: "oops", held: "nope" } }).lines).toEqual(["Nothing has been posted"]);
    expect(summarizeReviewTask({ kind: "future_kind", details: { foo: "bar", nested: { a: 1 } } }).lines).toEqual(["Foo: bar"]);
  });
});

describe("safeAppPath", () => {
  it("only allows internal paths and fixes party links", () => {
    expect(safeAppPath("/royalties/statements/abc")).toBe("/royalties/statements/abc");
    expect(safeAppPath("/catalog/partys/p1")).toBe("/catalog/parties/p1");
    expect(safeAppPath("//evil.example/x")).toBeNull();
    expect(safeAppPath("https://evil.example")).toBeNull();
    expect(safeAppPath("javascript:alert(1)")).toBeNull();
    expect(safeAppPath(null)).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formats queue ages compactly", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(42)).toBe("42s");
    expect(formatAge(600)).toBe("10m");
    expect(formatAge(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatAge(2 * 86400)).toBe("2d");
  });

  it("labels rotation grace periods", () => {
    expect(graceLabel(0)).toBe("Immediately");
    expect(graceLabel(24)).toBe("After 24 hours");
    expect(graceLabel(72)).toBe("After 3 days");
    expect(graceLabel(168)).toBe("After 7 days");
  });
});

describe("expiryLevelStyle", () => {
  it("keeps ok neutral and makes warning, critical and expired increasingly prominent", () => {
    expect(expiryLevelStyle("ok")).toMatchObject({ label: "OK", tone: "neutral", attention: false });
    expect(expiryLevelStyle("warning")).toMatchObject({ label: "Expires soon", tone: "warning", attention: true });
    expect(expiryLevelStyle("critical")).toMatchObject({ label: "Expires very soon", tone: "danger", attention: true });
    const expired = expiryLevelStyle("expired");
    expect(expired).toMatchObject({ label: "Expired", tone: "danger", attention: true });
    expect(expired.className).toContain("bg-danger-solid");
    expect(expiryLevelStyle("critical").className).toBeUndefined();
    expect(expiryLevelStyle("revoked")).toMatchObject({ tone: "neutral", attention: false });
  });

  it("tolerates unknown or missing levels", () => {
    expect(expiryLevelStyle("almost_gone")).toEqual({ label: "Almost Gone", tone: "neutral", attention: false });
    expect(expiryLevelStyle(null)).toMatchObject({ label: "OK" });
  });
});

describe("instance binding helpers", () => {
  it("shortens instance ids to 8 characters", () => {
    expect(shortInstanceId("abcd1234…")).toBe("abcd1234…");
    expect(shortInstanceId("abcd1234-5678-90ab")).toBe("abcd1234…");
    expect(shortInstanceId("abc")).toBe("abc");
    expect(shortInstanceId(null)).toBeNull();
  });

  it("allows releasing only bound, unrevoked keys", () => {
    expect(canReleaseInstance({ bound_instance: "abcd1234…", state: "active" })).toBe(true);
    expect(canReleaseInstance({ bound_instance: "abcd1234…", state: "expired" })).toBe(true);
    expect(canReleaseInstance({ bound_instance: "abcd1234…", state: "revoked" })).toBe(false);
    expect(canReleaseInstance({ bound_instance: null, state: "active" })).toBe(false);
  });
});

describe("statement automation helpers", () => {
  it("offers retry only where automation stopped", () => {
    expect(canRetryStatementState("needs_manual_review")).toBe(true);
    expect(canRetryStatementState("failed")).toBe(true);
    for (const state of ["retry_waiting", "awaiting_mapping", "pending", "processing", "completed"]) {
      expect(canRetryStatementState(state)).toBe(false);
    }
  });

  it("labels and colors states", () => {
    expect(statementStateLabel("retry_waiting")).toBe("Retry scheduled");
    expect(statementStateLabel("something_new")).toBe("Something New");
    expect(statementStateTone("needs_manual_review")).toBe("danger");
    expect(statementStateTone("retry_waiting")).toBe("warning");
    expect(statementStateTone("completed")).toBe("success");
    expect(errorCategoryLabel("transient")).toBe("Temporary error");
    expect(errorCategoryLabel(null)).toBeNull();
  });

  it("builds the mapping step path", () => {
    expect(statementMappingPath("st 1")).toBe("/royalties/statements/new?statement=st%201&step=map");
  });
});

describe("inbox file helpers", () => {
  it("prefers the error message and falls back to the humanized code", () => {
    expect(inboxErrorText({ error_code: "file_too_complex", error_message: "Too many sheets" })).toBe("Too many sheets");
    expect(inboxErrorText({ error_code: "file_too_complex" })).toBe("File too complex");
    expect(inboxErrorText({ error_code: null, error_message: null })).toBeNull();
    expect(inboxStateTone("rejected")).toBe("danger");
    expect(inboxStateTone("imported")).toBe("success");
  });
});
