import { compareDecimals, normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import type { Statement, StatementUpdate } from "@/lib/api/hooks/royalties";

export interface StatementEditForm {
  source_name: string;
  source_category: string;
  default_rights_type: string; // "" = category default
  period_start: string;
  period_end: string;
  currency: string;
  reported_total: string; // "" = none
  notes: string;
}

export type StatementEditErrors = Partial<Record<keyof StatementEditForm, string>>;

export function formFromStatement(statement: Statement): StatementEditForm {
  return {
    source_name: statement.source_name,
    source_category: statement.source_category,
    default_rights_type: statement.default_rights_type ?? "",
    period_start: statement.period_start,
    period_end: statement.period_end,
    currency: statement.currency,
    reported_total: statement.reported_total ?? "",
    notes: statement.notes ?? "",
  };
}

export function validateStatementEdit(form: StatementEditForm): StatementEditErrors {
  const errors: StatementEditErrors = {};
  if (!form.source_name.trim()) errors.source_name = "Enter the source name";
  else if (form.source_name.trim().length > 120) errors.source_name = "Use at most 120 characters";
  if (!form.period_start) errors.period_start = "Enter the period start date";
  if (!form.period_end) errors.period_end = "Enter the period end date";
  if (form.period_start && form.period_end && form.period_end < form.period_start) {
    errors.period_end = "Period end must be on or after the start";
  }
  if (!/^[A-Z]{3}$/.test(form.currency)) errors.currency = "Choose a 3-letter currency code";
  const total = validateAmount(form.reported_total, { required: false, allowNegative: true, allowZero: true, maxDecimals: 8 });
  if (total) errors.reported_total = total;
  if (form.notes.length > 5000) errors.notes = "Use at most 5,000 characters";
  return errors;
}

/** PATCH body containing only the fields that changed. */
export function buildStatementPatch(original: Statement, form: StatementEditForm): StatementUpdate {
  const patch: StatementUpdate = {};
  const name = form.source_name.trim();
  if (name !== original.source_name) patch.source_name = name;
  if (form.source_category !== original.source_category) {
    patch.source_category = form.source_category as StatementUpdate["source_category"];
  }
  if (form.default_rights_type !== (original.default_rights_type ?? "")) {
    if (form.default_rights_type) patch.default_rights_type = form.default_rights_type as StatementUpdate["default_rights_type"];
    else patch.clear_default_rights_type = true;
  }
  if (form.period_start !== original.period_start) patch.period_start = form.period_start;
  if (form.period_end !== original.period_end) patch.period_end = form.period_end;
  if (form.currency !== original.currency) patch.currency = form.currency;
  const total = form.reported_total.trim();
  const originalTotal = original.reported_total ?? "";
  if (total === "" && originalTotal !== "") patch.clear_reported_total = true;
  else if (total !== "" && (originalTotal === "" || compareDecimals(normalizeAmountInput(total), originalTotal) !== 0)) {
    patch.reported_total = normalizeAmountInput(total);
  }
  if (form.notes !== (original.notes ?? "")) patch.notes = form.notes;
  return patch;
}

/** Fields whose change discards unposted calculations (mirrors the backend). */
export const CALCULATION_FIELDS: (keyof StatementUpdate)[] = [
  "source_category",
  "default_rights_type",
  "clear_default_rights_type",
  "period_start",
  "period_end",
];

export function affectsCalculation(patch: StatementUpdate): boolean {
  return CALCULATION_FIELDS.some((field) => field in patch);
}
