import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";

import { contractFormErrors } from "../contract-errors";
import {
  buildReviewPayload,
  candidateValue,
  differsFromCurrent,
  expiryDisplay,
  hasCandidate,
  isTransitionAllowed,
  isValidAmount,
  selectableFields,
  statusOptions,
} from "../contract-format";

describe("contract status transitions", () => {
  it("offers creatable statuses for a new contract", () => {
    expect(statusOptions(null)).toEqual(["draft", "pending_signature", "active"]);
  });

  it("offers the current status plus allowed transitions", () => {
    expect(statusOptions("active")).toEqual(["active", "expired", "terminated"]);
    expect(statusOptions("terminated")).toEqual(["terminated"]);
    // The backend's allowed list wins when provided.
    expect(statusOptions("draft", ["active"])).toEqual(["draft", "active"]);
  });

  it("checks individual transitions", () => {
    expect(isTransitionAllowed("draft", "active")).toBe(true);
    expect(isTransitionAllowed("active", "draft")).toBe(false);
    expect(isTransitionAllowed("expired", "active")).toBe(true);
    expect(isTransitionAllowed("terminated", "active")).toBe(false);
    expect(isTransitionAllowed("active", "active")).toBe(true);
  });
});

describe("expiry display", () => {
  it("describes upcoming, expired and open-ended contracts", () => {
    expect(expiryDisplay("upcoming", 12)).toEqual({ label: "Expires in 12 days", tone: "warning" });
    expect(expiryDisplay("upcoming", 0, true).label).toBe("Expires today · auto-renews");
    expect(expiryDisplay("expired", -3)).toEqual({ label: "Expired 3 days ago", tone: "danger" });
    expect(expiryDisplay("none", null).label).toBe("No end date");
    expect(expiryDisplay("none", 200).tone).toBe("success");
  });
});

describe("money", () => {
  it("validates amounts like the backend", () => {
    expect(isValidAmount("1000")).toBe(true);
    expect(isValidAmount("1000.12345678")).toBe(true);
    expect(isValidAmount("1000.123456789")).toBe(false);
    expect(isValidAmount("-5")).toBe(false);
    expect(isValidAmount("1e3")).toBe(false);
  });
});

describe("analysis review field selection", () => {
  const contract = {
    title: "Old title",
    contract_type: "publishing",
    start_date: "2024-01-01",
    end_date: null,
    renewal_date: null,
    territories: ["WORLD"],
    rights_granted: ["performance", "mechanical"],
    currency: "USD",
    advance_amount: "5000.00000000",
    summary: null,
  };
  const extracted = {
    title: "New title",
    contract_type: "publishing",
    start_date: "2024-01-01",
    end_date: "2027-12-31",
    renewal_date: null,
    territories: ["WORLD"],
    rights_granted: ["mechanical", "performance"],
    currency: "usd",
    advance_amount: "5,000",
    term_summary: "Three-year publishing deal.",
  };

  it("maps summary to term_summary and detects missing candidates", () => {
    expect(candidateValue("summary", extracted)).toBe("Three-year publishing deal.");
    expect(hasCandidate("renewal_date", extracted)).toBe(false);
    expect(hasCandidate("end_date", extracted)).toBe(true);
    expect(hasCandidate("title", null)).toBe(false);
  });

  it("compares values ignoring order, case and number formatting", () => {
    expect(differsFromCurrent("rights_granted", extracted, contract)).toBe(false);
    expect(differsFromCurrent("currency", extracted, contract)).toBe(false);
    expect(differsFromCurrent("advance_amount", extracted, contract)).toBe(false);
    expect(differsFromCurrent("title", extracted, contract)).toBe(true);
  });

  it("lists only fields that have a differing candidate", () => {
    expect(selectableFields(extracted, contract)).toEqual(["title", "end_date", "summary"]);
  });

  it("builds payloads in whitelist order and never applies on reject", () => {
    expect(buildReviewPayload("accepted", new Set(["summary", "title"] as const), "  checked  ")).toEqual({
      decision: "accepted",
      notes: "checked",
      apply_fields: ["title", "summary"],
    });
    expect(buildReviewPayload("rejected", ["title"], "")).toEqual({ decision: "rejected", notes: null, apply_fields: [] });
  });
});

describe("contract save errors", () => {
  it("maps nested 422 locations to rows", () => {
    const error = new ApiError({
      status: 422,
      code: "validation_failed",
      message: "Some fields are invalid.",
      details: [
        { loc: ["body", "parties", 1, "party_id"], message: "Field required", type: "missing" },
        { loc: ["body", "royalty_terms", 0, "rate_percent"], message: "Too big", type: "value_error" },
        { loc: ["body", "title"], message: "Title is required", type: "value_error" },
      ],
    });
    expect(contractFormErrors(error)).toEqual({ fields: { "parties.1": "Field required", "terms.0": "Too big", title: "Title is required" }, form: null });
  });

  it("maps business conflicts to fields and form messages", () => {
    const transition = new ApiError({ status: 409, code: "invalid_status_transition", message: "A contract cannot move from 'active' to 'draft'" });
    expect(contractFormErrors(transition)).toEqual({ fields: { status: transition.message }, form: transition.message });
    const duplicate = new ApiError({ status: 409, code: "duplicate_reference", message: "A contract with this reference already exists" });
    expect(contractFormErrors(duplicate).fields.reference).toBe(duplicate.message);
    expect(contractFormErrors(new ApiError({ status: 500, code: "server_error", message: "Boom" })).form).toBe("Boom");
  });
});

describe("trimDecimal", () => {
  it("strips trailing zeros without float conversion", async () => {
    const { trimDecimal } = await import("../contract-format");
    expect(trimDecimal("25000.00000000")).toBe("25000");
    expect(trimDecimal("12.50")).toBe("12.5");
    expect(trimDecimal("100")).toBe("100");
  });
});
