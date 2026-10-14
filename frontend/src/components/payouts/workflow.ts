import type { BadgeTone } from "@/components/ui/badge";
import type { Role } from "@/lib/api/types";
import { hasRole } from "@/lib/roles";
import { titleCase } from "@/lib/utils";

export type BatchStatus = "draft" | "pending_approval" | "approved" | "paid" | "cancelled";

export interface BatchLike {
  status: string;
  submitted_at?: string | null;
  approved_at?: string | null;
  paid_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
}

export type StepState = "complete" | "current" | "upcoming" | "cancelled";

export interface WorkflowStep {
  key: Exclude<BatchStatus, "cancelled">;
  label: string;
  state: StepState;
  at: string | null;
}

const STEP_DEFS: { key: Exclude<BatchStatus, "cancelled">; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "pending_approval", label: "Pending approval" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Recorded as paid" },
];

const ORDER: Record<string, number> = { draft: 0, pending_approval: 1, approved: 2, paid: 3 };

/**
 * Derives the stepper state for a payout batch. A cancelled batch keeps the
 * steps it reached (from the workflow timestamps) and marks the step it was
 * cancelled at.
 */
export function batchWorkflow(batch: BatchLike): { steps: WorkflowStep[]; cancelled: boolean } {
  const timestamps: Record<string, string | null> = {
    draft: batch.created_at ?? null,
    pending_approval: batch.submitted_at ?? null,
    approved: batch.approved_at ?? null,
    paid: batch.paid_at ?? null,
  };
  if (batch.status === "cancelled") {
    // Reached = the furthest step with a timestamp (draft is always reached).
    const reached = batch.approved_at ? 2 : batch.submitted_at ? 1 : 0;
    const steps = STEP_DEFS.map((def, index): WorkflowStep => ({
      ...def,
      at: index <= reached ? timestamps[def.key] : index === reached + 1 ? (batch.cancelled_at ?? null) : null,
      state: index <= reached ? "complete" : index === reached + 1 ? "cancelled" : "upcoming",
    }));
    return { steps, cancelled: true };
  }
  const current = ORDER[batch.status] ?? 0;
  const steps = STEP_DEFS.map((def, index): WorkflowStep => {
    let state: StepState = index < current ? "complete" : index === current ? "current" : "upcoming";
    // "Paid" is a terminal state: the last step is complete rather than in progress.
    if (batch.status === "paid" && index === current) state = "complete";
    return { ...def, state, at: index <= current ? timestamps[def.key] : null };
  });
  return { steps, cancelled: false };
}

export interface BatchPermissions {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canMarkPaid: boolean;
  canCancel: boolean;
}

/** Mirrors the role and status rules in backend/app/services/payouts.py. */
export function batchPermissions(status: string, role: Role | null | undefined): BatchPermissions {
  const manager = hasRole(role, "manager");
  const admin = hasRole(role, "admin");
  return {
    canEdit: status === "draft" && manager,
    canSubmit: status === "draft" && manager,
    canApprove: status === "pending_approval" && admin,
    canMarkPaid: status === "approved" && admin,
    canCancel: ((status === "draft" || status === "pending_approval") && manager) || (status === "approved" && admin),
  };
}

const BATCH_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Pending approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  paid: { label: "Recorded as paid", tone: "success" },
  cancelled: { label: "Cancelled", tone: "danger" },
};

export function batchStatus(status: string): { label: string; tone: BadgeTone } {
  return BATCH_STATUS[status] ?? { label: titleCase(status), tone: "neutral" };
}

export const BATCH_STATUSES: BatchStatus[] = ["draft", "pending_approval", "approved", "paid", "cancelled"];

const PAYMENT_METHODS: Record<string, string> = {
  bank_transfer: "Bank transfer",
  paypal: "PayPal",
  check: "Check",
  wire: "Wire",
  other: "Other",
};

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return PAYMENT_METHODS[method] ?? titleCase(method);
}

export const PAYMENT_METHOD_OPTIONS = Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label }));

const ENTRY_TYPES: Record<string, { label: string; tone: BadgeTone; description: string }> = {
  earning: { label: "Earning", tone: "success", description: "Royalties posted from a calculation run" },
  adjustment: { label: "Adjustment", tone: "info", description: "Manual adjustment recorded by an admin" },
  advance: { label: "Advance", tone: "warning", description: "Recoupable advance (recovered from future earnings)" },
  payout: { label: "Payout", tone: "primary", description: "Payment recorded as made outside RightsFlow" },
  reversal: { label: "Reversal", tone: "neutral", description: "Offsetting entry for a reversed item" },
};

export function entryType(type: string): { label: string; tone: BadgeTone; description: string } {
  return ENTRY_TYPES[type] ?? { label: titleCase(type), tone: "neutral", description: "" };
}

/** Summarizes non-sensitive payment reference fields, e.g. "Chase ···1234". */
export function paymentReferenceSummary(reference: Record<string, unknown> | null | undefined): string | null {
  if (!reference) return null;
  const parts: string[] = [];
  const bank = typeof reference.bank_name === "string" ? reference.bank_name : null;
  const last4 = typeof reference.account_last4 === "string" ? reference.account_last4 : null;
  const paypal = typeof reference.paypal_email === "string" ? reference.paypal_email : null;
  const ref = typeof reference.reference === "string" ? reference.reference : null;
  if (bank || last4) parts.push([bank, last4 ? `···${last4}` : null].filter(Boolean).join(" "));
  if (paypal) parts.push(paypal);
  if (ref) parts.push(`Ref ${ref}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
