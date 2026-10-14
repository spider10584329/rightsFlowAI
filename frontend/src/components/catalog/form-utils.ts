import { isApiError, validationIssues } from "@/lib/api/errors";

/** Trims and converts blank strings to `null` (backend `_blank_to_none`). */
export function toNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

/**
 * Maps a 422 to form keys. Top-level fields use their name (`iswc`); nested
 * ones use a dotted path (`contributors.0.party_id`) and also set the
 * collection key (`contributors`) so list editors can show a summary.
 */
export function formErrorsFrom(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of validationIssues(error)) {
    const path = issue.loc[0] === "body" ? issue.loc.slice(1) : issue.loc;
    if (path.length === 0 || (path[0] === "query" && path.length === 1)) {
      result._form ??= issue.message;
      continue;
    }
    const key = path.join(".");
    result[key] ??= issue.message;
    if (path.length > 1) result[path[0]] ??= issue.message;
  }
  return result;
}

export interface DuplicateConflict {
  message: string;
  field: string | null;
  existingId: string | null;
}

/** `409 duplicate_identifier`: another item already uses the ISWC/ISRC/UPC. */
export function duplicateConflict(error: unknown): DuplicateConflict | null {
  if (!isApiError(error) || error.status !== 409 || error.code !== "duplicate_identifier") return null;
  const details = (error.details ?? {}) as { field?: unknown; existing_id?: unknown };
  return {
    message: error.message.replace(/\s*Pass allow_duplicate=true to create it anyway\.?$/i, ""),
    field: typeof details.field === "string" ? details.field : null,
    existingId: typeof details.existing_id === "string" ? details.existing_id : null,
  };
}

/** `409 duplicate_internal_code` maps onto the internal code field. */
export function internalCodeConflict(error: unknown): string | null {
  return isApiError(error) && error.code === "duplicate_internal_code" ? error.message : null;
}

export interface ContributorRow {
  key: string;
  party_id: string;
  party_name: string;
  role: string;
  instrument?: string;
}

/** Row-level problems: missing party/role and repeated party + role pairs. */
export function contributorRowErrors(rows: readonly ContributorRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.party_id) {
      errors[row.key] = "Choose a party";
      continue;
    }
    if (!row.role) {
      errors[row.key] = "Choose a role";
      continue;
    }
    const pair = `${row.party_id}:${row.role}`;
    if (seen.has(pair)) errors[row.key] = "This party already has this role";
    seen.add(pair);
  }
  return errors;
}

let counter = 0;
/** Stable client-side key for list rows. */
export function rowKey(prefix = "row"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Returns a copy without `key` (or the same object when absent). */
export function omitKey<T extends Record<string, unknown>>(record: T, key: string): T {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
