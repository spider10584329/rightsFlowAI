import { describe, expect, it } from "vitest";

import { batchPermissions, batchWorkflow, paymentReferenceSummary } from "@/components/payouts/workflow";

const states = (status: string, extra: Record<string, string | null> = {}) =>
  batchWorkflow({ status, created_at: "2026-10-01T10:00:00", ...extra }).steps.map((step) => step.state);

describe("batchWorkflow", () => {
  it("marks the current step for in-flight batches", () => {
    expect(states("draft")).toEqual(["current", "upcoming", "upcoming", "upcoming"]);
    expect(states("pending_approval", { submitted_at: "x" })).toEqual(["complete", "current", "upcoming", "upcoming"]);
    expect(states("approved", { submitted_at: "x", approved_at: "y" })).toEqual(["complete", "complete", "current", "upcoming"]);
  });

  it("treats recorded-as-paid as fully complete", () => {
    const { steps, cancelled } = batchWorkflow({ status: "paid", submitted_at: "a", approved_at: "b", paid_at: "c" });
    expect(cancelled).toBe(false);
    expect(steps.map((s) => s.state)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(steps[3].at).toBe("c");
  });

  it("shows where a cancelled batch stopped", () => {
    expect(states("cancelled", { cancelled_at: "z" })).toEqual(["complete", "cancelled", "upcoming", "upcoming"]);
    expect(states("cancelled", { submitted_at: "a", cancelled_at: "z" })).toEqual(["complete", "complete", "cancelled", "upcoming"]);
    const approvedThenCancelled = batchWorkflow({ status: "cancelled", submitted_at: "a", approved_at: "b", cancelled_at: "z" });
    expect(approvedThenCancelled.cancelled).toBe(true);
    expect(approvedThenCancelled.steps.map((s) => s.state)).toEqual(["complete", "complete", "complete", "cancelled"]);
    expect(approvedThenCancelled.steps[3].at).toBe("z");
  });
});

describe("batchPermissions", () => {
  it("lets managers edit, submit and cancel drafts but not approve", () => {
    expect(batchPermissions("draft", "manager")).toEqual({ canEdit: true, canSubmit: true, canApprove: false, canMarkPaid: false, canCancel: true });
    expect(batchPermissions("pending_approval", "manager").canApprove).toBe(false);
  });

  it("reserves approval, recording payment and cancelling approved batches for admins", () => {
    expect(batchPermissions("pending_approval", "admin").canApprove).toBe(true);
    expect(batchPermissions("approved", "admin")).toMatchObject({ canMarkPaid: true, canCancel: true, canEdit: false });
    expect(batchPermissions("approved", "manager")).toMatchObject({ canMarkPaid: false, canCancel: false });
    expect(batchPermissions("approved", "owner").canMarkPaid).toBe(true);
  });

  it("allows nothing on terminal batches or for viewers", () => {
    for (const status of ["paid", "cancelled"]) {
      expect(Object.values(batchPermissions(status, "owner")).some(Boolean)).toBe(false);
    }
    expect(Object.values(batchPermissions("draft", "viewer")).some(Boolean)).toBe(false);
  });
});

describe("paymentReferenceSummary", () => {
  it("summarizes only non-sensitive fields", () => {
    expect(paymentReferenceSummary({ bank_name: "Chase", account_last4: "1234" })).toBe("Chase ···1234");
    expect(paymentReferenceSummary({ paypal_email: "a@b.co", reference: "INV-9" })).toBe("a@b.co · Ref INV-9");
    expect(paymentReferenceSummary(null)).toBeNull();
  });
});
