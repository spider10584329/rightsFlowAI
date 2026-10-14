/**
 * Line-editor helpers for manual statements (`POST /royalties/statements/manual`).
 * Rules mirror `ManualLine` in backend/app/schemas/royalty.py. Totals are
 * computed with exact decimal arithmetic (BigInt), never floats.
 */
import { isApiError, validationIssues } from "@/lib/api/errors";

import { addDecimals, normalizeAmountInput, validateAmount } from "./money";

export interface ManualLineDraft {
  /** Client-only key for React lists. */
  key: string;
  target: { kind: "recording" | "work"; id: string; title: string } | null;
  title: string;
  isrc: string;
  iswc: string;
  territory: string;
  rights_type: string;
  usage_type: string;
  amount: string;
  transaction_date: string;
  description: string;
}

export type ManualLineField = Exclude<keyof ManualLineDraft, "key"> | "row";
export type ManualLineErrors = Partial<Record<ManualLineField, string>>;

export const MAX_MANUAL_LINES = 5000;

let counter = 0;
export function emptyLine(): ManualLineDraft {
  counter += 1;
  return { key: `line-${counter}`, target: null, title: "", isrc: "", iswc: "", territory: "", rights_type: "", usage_type: "", amount: "", transaction_date: "", description: "" };
}

/** Amount rules: required, may be negative (refunds/corrections), 8 decimals, 20 digits. */
export function validateLineAmount(amount: string): string | null {
  return validateAmount(amount, { allowNegative: true, allowZero: true, maxDecimals: 8, maxDigits: 20 });
}

export function validateManualLine(line: ManualLineDraft): ManualLineErrors {
  const errors: ManualLineErrors = {};
  const amount = validateLineAmount(line.amount);
  if (amount) errors.amount = amount;
  if (line.title.length > 255) errors.title = "Use at most 255 characters";
  if (line.isrc && !/^[A-Za-z]{2}-?[A-Za-z0-9]{3}-?\d{2}-?\d{5}$/.test(line.isrc.trim())) errors.isrc = "ISRC looks like CC-XXX-YY-NNNNN";
  if (line.isrc.length > 20) errors.isrc = "Use at most 20 characters";
  if (line.iswc.length > 20) errors.iswc = "Use at most 20 characters";
  if (line.usage_type.length > 60) errors.usage_type = "Use at most 60 characters";
  if (line.description.length > 255) errors.description = "Use at most 255 characters";
  return errors;
}

export interface ManualLinesValidation {
  valid: boolean;
  rows: ManualLineErrors[];
  errors: string[];
  /** Rows (0-based) that carry no identifier at all: allowed, but they stay unmatched. */
  unidentified: number[];
}

export function validateManualLines(lines: readonly ManualLineDraft[]): ManualLinesValidation {
  const rows = lines.map(validateManualLine);
  const errors: string[] = [];
  if (lines.length === 0) errors.push("Add at least one line.");
  if (lines.length > MAX_MANUAL_LINES) errors.push(`Use at most ${MAX_MANUAL_LINES.toLocaleString()} lines.`);
  const unidentified = lines.flatMap((line, index) => (!line.target && !line.isrc.trim() && !line.iswc.trim() && !line.title.trim() ? [index] : []));
  const valid = errors.length === 0 && rows.every((row) => Object.keys(row).length === 0);
  return { valid, rows, errors, unidentified };
}

/**
 * Exact total of every amount that parses. Returns the total and how many
 * lines were left out because their amount is empty or invalid.
 */
export function manualLinesTotal(lines: readonly ManualLineDraft[]): { total: string; counted: number; skipped: number } {
  let total = "0";
  let counted = 0;
  for (const line of lines) {
    if (validateLineAmount(line.amount)) continue;
    total = addDecimals(total, normalizeAmountInput(line.amount).replace(/^\+/, ""));
    counted += 1;
  }
  return { total, counted, skipped: lines.length - counted };
}

export interface ManualLinePayload {
  title?: string;
  isrc?: string;
  iswc?: string;
  recording_id?: string;
  work_id?: string;
  territory?: string;
  rights_type?: string;
  usage_type?: string;
  amount: string;
  transaction_date?: string;
  description?: string;
}

export function toLinePayload(line: ManualLineDraft): ManualLinePayload {
  const payload: ManualLinePayload = { amount: normalizeAmountInput(line.amount).replace(/^\+/, "") };
  const text = (value: string) => value.trim() || undefined;
  if (text(line.title)) payload.title = line.title.trim();
  if (text(line.isrc)) payload.isrc = line.isrc.trim().toUpperCase();
  if (text(line.iswc)) payload.iswc = line.iswc.trim().toUpperCase();
  if (line.target?.kind === "recording") payload.recording_id = line.target.id;
  if (line.target?.kind === "work") payload.work_id = line.target.id;
  if (line.territory) payload.territory = line.territory;
  if (line.rights_type) payload.rights_type = line.rights_type;
  if (text(line.usage_type)) payload.usage_type = line.usage_type.trim();
  if (line.transaction_date) payload.transaction_date = line.transaction_date;
  if (text(line.description)) payload.description = line.description.trim();
  return payload;
}

const LINE_FIELDS = new Set<string>(["title", "isrc", "iswc", "recording_id", "work_id", "territory", "rights_type", "usage_type", "amount", "transaction_date", "description"]);

/**
 * Maps a backend error to rows: 422 `loc` paths like `["body","lines",2,"amount"]`
 * and service messages like `Line 3: unknown territory 'XX'` (1-based).
 * Remaining issues are returned as general (form-level) messages.
 */
export function mapManualApiErrors(error: unknown): { rows: Record<number, ManualLineErrors>; fields: Record<string, string>; general: string[] } {
  const rows: Record<number, ManualLineErrors> = {};
  const fields: Record<string, string> = {};
  const general: string[] = [];
  const addRow = (index: number, field: ManualLineField, message: string) => {
    rows[index] = { ...rows[index], [field]: rows[index]?.[field] ?? message };
  };
  if (!isApiError(error)) return { rows, fields, general: [error instanceof Error ? error.message : "Something went wrong."] };
  const issues = validationIssues(error);
  for (const issue of issues) {
    const loc = issue.loc[0] === "body" ? issue.loc.slice(1) : issue.loc;
    if (loc[0] === "lines" && loc.length >= 2 && /^\d+$/.test(loc[1])) {
      const index = Number(loc[1]);
      const field = loc[2];
      if (field && LINE_FIELDS.has(field)) addRow(index, field === "recording_id" || field === "work_id" ? "target" : (field as ManualLineField), issue.message);
      else addRow(index, "row", issue.message);
    } else if (loc[0] === "lines") {
      general.push(issue.message);
    } else if (loc.length > 0 && loc[0]) {
      fields[loc[loc.length - 1]] ??= issue.message;
    } else {
      general.push(issue.message);
    }
  }
  if (issues.length === 0) {
    const match = /^Line (\d+):\s*(.*)$/i.exec(error.message);
    if (match) {
      const index = Number(match[1]) - 1;
      addRow(index, /territory/i.test(match[2]) ? "territory" : "row", match[2]);
    } else general.push(error.message);
  }
  return { rows, fields, general };
}
