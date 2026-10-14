import { rowKey } from "@/components/catalog/form-utils";
import type { ExternalIdsInput } from "@/lib/api/hooks/catalog";

export interface ExternalIdRow {
  key: string; // React key
  name: string;
  value: string;
}

/** Common identifier names offered as suggestions (free text is allowed). */
export const EXTERNAL_ID_SUGGESTIONS = [
  "spotify_id",
  "apple_music_id",
  "youtube_id",
  "deezer_id",
  "amazon_asin",
  "musicbrainz_id",
  "ascap_work_id",
  "bmi_work_id",
  "prs_tune_code",
  "gema_work_id",
  "socan_work_id",
  "mlc_song_code",
  "hfa_song_code",
  "distributor_id",
] as const;

export const MAX_EXTERNAL_IDS = 50;

export function rowsFromExternalIds(value: Record<string, unknown> | null | undefined): ExternalIdRow[] {
  return Object.entries(value ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([name, v]) => ({ key: rowKey("ext"), name, value: String(v) }));
}

/** Row-level errors keyed `${row.key}.name` / `${row.key}.value`, plus `external_ids` for list errors. */
export function validateExternalIds(rows: readonly ExternalIdRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const filled = rows.filter((row) => row.name.trim() || row.value.trim());
  if (filled.length > MAX_EXTERNAL_IDS) errors.external_ids = `At most ${MAX_EXTERNAL_IDS} external ids are allowed`;
  const seen = new Set<string>();
  for (const row of filled) {
    const name = row.name.trim();
    if (!name) errors[`${row.key}.name`] = "Enter an identifier name";
    else if (name.length > 50) errors[`${row.key}.name`] = "Use at most 50 characters";
    else if (seen.has(name.toLowerCase())) errors[`${row.key}.name`] = "This name is already used";
    seen.add(name.toLowerCase());
    if (!row.value.trim()) errors[`${row.key}.value`] = "Enter a value";
    else if (row.value.trim().length > 255) errors[`${row.key}.value`] = "Use at most 255 characters";
  }
  return errors;
}

/** API payload: trimmed pairs, empty rows dropped; `null` clears all ids. */
export function externalIdsPayload(rows: readonly ExternalIdRow[]): ExternalIdsInput {
  const entries = rows
    .map((row) => [row.name.trim(), row.value.trim()] as const)
    .filter(([name, value]) => name && value);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
