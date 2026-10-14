/**
 * Column-mapping helpers for the statement upload wizard. They mirror the
 * backend rules in `royalty_import.update_mapping`: `amount` is required, at
 * least one identifying field (ISRC, ISWC, UPC or title) must be mapped, and
 * every mapped column must exist in the file.
 */

export const REQUIRED_FIELD = "amount";
export const IDENTIFYING_FIELDS = ["isrc", "iswc", "upc", "title"] as const;

/** Display order for canonical fields (identifiers and money first). */
export const FIELD_ORDER = [
  "amount",
  "isrc",
  "iswc",
  "upc",
  "title",
  "artist",
  "currency",
  "territory",
  "transaction_date",
  "quantity",
  "gross_amount",
  "store",
  "usage_type",
  "rights_type",
  "source_reference",
];

export type ColumnMapping = Record<string, string>;

export interface MappingValidation {
  valid: boolean;
  /** Blocking problems (shown above the form). */
  errors: string[];
  /** Per canonical field messages. */
  fieldErrors: Record<string, string>;
  /** Non-blocking hints. */
  warnings: string[];
}

/** Drops unmapped (empty) entries. */
export function cleanMapping(mapping: ColumnMapping): ColumnMapping {
  return Object.fromEntries(Object.entries(mapping).filter(([, column]) => Boolean(column && column.trim())));
}

export function validateMapping(mapping: ColumnMapping, headers: readonly string[], knownFields?: readonly string[]): MappingValidation {
  const clean = cleanMapping(mapping);
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};
  const warnings: string[] = [];
  const headerSet = new Set(headers);

  for (const [field, column] of Object.entries(clean)) {
    if (knownFields && !knownFields.includes(field)) {
      fieldErrors[field] = "Unknown field";
    } else if (!headerSet.has(column)) {
      fieldErrors[field] = `Column "${column}" is not in this file`;
    }
  }
  if (Object.keys(fieldErrors).length > 0) errors.push("Some mapped columns do not exist in the file.");

  if (!clean[REQUIRED_FIELD]) {
    fieldErrors[REQUIRED_FIELD] ??= "Map the net amount column (required)";
    errors.push("Map a column to the net amount payable (required).");
  }
  if (!IDENTIFYING_FIELDS.some((field) => clean[field])) {
    errors.push("Map at least one identifying column: ISRC, ISWC, UPC or title.");
  }

  const byColumn = new Map<string, string[]>();
  for (const [field, column] of Object.entries(clean)) {
    byColumn.set(column, [...(byColumn.get(column) ?? []), field]);
  }
  for (const [column, fields] of byColumn) {
    if (fields.length > 1) warnings.push(`Column "${column}" is mapped to ${fields.join(", ")}.`);
  }
  if (clean.amount && clean.gross_amount && clean.amount === clean.gross_amount) {
    warnings.push("Net and gross amount use the same column; contract rates on a gross basis will equal net.");
  }
  if (!clean.currency) warnings.push("No currency column: every line uses the statement currency.");
  if (!clean.isrc && !clean.iswc && clean.title) warnings.push("Only titles identify lines; matching will be less reliable than with ISRC/ISWC.");

  return { valid: errors.length === 0, errors, fieldErrors, warnings };
}

/**
 * Overlays a suggested mapping (from the detector or AI) on the current one,
 * keeping only suggestions that point at real columns of this file.
 */
export function applySuggestions(current: ColumnMapping, suggestion: ColumnMapping, headers: readonly string[]): { mapping: ColumnMapping; applied: string[]; skipped: string[] } {
  const headerSet = new Set(headers);
  const mapping = { ...current };
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [field, column] of Object.entries(suggestion)) {
    if (!column) continue;
    if (!headerSet.has(column)) {
      skipped.push(field);
      continue;
    }
    if (mapping[field] !== column) applied.push(field);
    mapping[field] = column;
  }
  return { mapping, applied, skipped };
}

/** Sorts canonical field keys into the display order, unknown keys last. */
export function orderedFields(fields: readonly string[]): string[] {
  return [...fields].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
  });
}
