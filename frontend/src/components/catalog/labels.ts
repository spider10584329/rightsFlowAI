import type { BadgeTone } from "@/components/ui/badge";
import { ENTITY_SEGMENT, type CatalogEntityType } from "@/lib/api/hooks/catalog";
import { titleCase } from "@/lib/utils";

export const ENTITY_LABEL: Record<CatalogEntityType, { singular: string; plural: string }> = {
  work: { singular: "Work", plural: "Works" },
  recording: { singular: "Recording", plural: "Recordings" },
  release: { singular: "Release", plural: "Releases" },
  party: { singular: "Party", plural: "Artists & contributors" },
};

export function entityHref(entity: CatalogEntityType, id?: string, suffix?: "edit"): string {
  const base = `/catalog/${ENTITY_SEGMENT[entity]}`;
  if (!id) return base;
  return suffix ? `${base}/${id}/${suffix}` : `${base}/${id}`;
}

/** Accepts backend aliases ("works", "parties", ...) and returns the canonical type. */
export function toEntityType(value: string | null | undefined): CatalogEntityType | null {
  switch ((value ?? "").toLowerCase()) {
    case "work":
    case "works":
      return "work";
    case "recording":
    case "recordings":
      return "recording";
    case "release":
    case "releases":
      return "release";
    case "party":
    case "parties":
      return "party";
    default:
      return null;
  }
}

const SPECIAL_LABELS: Record<string, string> = {
  composer_lyricist: "Composer & lyricist",
  original_publisher: "Original publisher",
  sub_publisher: "Sub-publisher",
  co_producer: "Co-producer",
  main_artist: "Main artist",
  featured_artist: "Featured artist",
  mastering_engineer: "Mastering engineer",
  ep: "EP",
};

/** Human label for a role, type or status code. */
export function codeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return SPECIAL_LABELS[code] ?? titleCase(code);
}

export const STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  draft: "info",
  archived: "neutral",
};

export const VERIFICATION_TONE: Record<string, BadgeTone> = {
  verified: "success",
  unverified: "warning",
  disputed: "danger",
};

/** Completeness `missing` keys from `completeness_score` in the backend service. */
export const MISSING_FIELD_LABELS: Record<string, string> = {
  iswc: "Valid ISWC",
  writers: "Writers (composer / lyricist)",
  publisher: "Publisher",
  language: "Language",
  genre: "Genre",
  creation_year: "Creation year",
  internal_code: "Internal code",
  isrc: "Valid ISRC",
  artist: "Artist",
  linked_work: "Linked work",
  duration: "Duration",
  contributors: "Contributors",
  p_line: "℗ line",
  recording_date: "Recording date",
  upc: "Valid UPC/EAN",
  tracks: "Tracks",
  label: "Label",
  release_date: "Release date",
  display_artist: "Display artist",
  c_line: "© line",
  catalog_number: "Catalog number",
};

export function missingLabel(key: string): string {
  return MISSING_FIELD_LABELS[key] ?? titleCase(key);
}

export type CompletenessBand = "complete" | "high" | "medium" | "low";

/** Mirrors `completeness_band` in the backend. */
export function completenessBand(score: number): CompletenessBand {
  if (score >= 100) return "complete";
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

export const BAND_META: Record<CompletenessBand, { label: string; range: string; tone: BadgeTone; bar: string }> = {
  complete: { label: "Complete", range: "100", tone: "success", bar: "bg-success" },
  high: { label: "High", range: "80–99", tone: "info", bar: "bg-info" },
  medium: { label: "Medium", range: "50–79", tone: "warning", bar: "bg-warning" },
  low: { label: "Low", range: "0–49", tone: "danger", bar: "bg-danger" },
};

/** `missing_identifiers` keys from `/catalog/summary`, with list filters where the backend has one. */
export const MISSING_IDENTIFIER_META: Record<string, { label: string; href?: string }> = {
  works_without_iswc: { label: "Works without ISWC", href: "/catalog/works?has_iswc=false" },
  works_without_writers: { label: "Works without writers" },
  recordings_without_isrc: { label: "Recordings without ISRC", href: "/catalog/recordings?has_isrc=false" },
  recordings_without_work: { label: "Recordings not linked to a work", href: "/catalog/recordings?has_work=false" },
  releases_without_upc: { label: "Releases without UPC/EAN", href: "/catalog/releases?has_upc=false" },
  releases_without_tracks: { label: "Releases without tracks" },
  writers_without_ipi: { label: "Writers without IPI" },
};

export const ISSUE_CODE_LABELS: Record<string, string> = {
  missing_iswc: "Missing ISWC",
  invalid_iswc: "Invalid ISWC",
  missing_contributors: "No contributors",
  no_writers: "No writers",
  no_recordings: "No linked recordings",
  missing_isrc: "Missing ISRC",
  invalid_isrc: "Invalid ISRC",
  no_linked_work: "No linked work",
  missing_artist: "Missing artist",
  missing_duration: "Missing duration",
  missing_upc: "Missing UPC/EAN",
  invalid_upc: "Invalid UPC/EAN",
  no_tracks: "No tracks",
  missing_label: "Missing label",
  missing_release_date: "Missing release date",
  invalid_ipi: "Invalid IPI",
  missing_ipi: "Missing IPI",
  invalid_isni: "Invalid ISNI",
  missing_roles: "No roles",
};

export function issueCodeLabel(code: string): string {
  return ISSUE_CODE_LABELS[code] ?? titleCase(code);
}

export const SEVERITY_TONE: Record<string, BadgeTone> = { error: "danger", warning: "warning", info: "info" };

/** Human description for the audit action of a catalog entity, e.g. `work.updated`. */
export function activityLabel(action: string): string {
  const verb = action.split(".").pop() ?? action;
  return titleCase(verb);
}

/** Party reference keys from `reference_counts` (delete blockers). */
export function referenceLabel(key: string): string {
  return titleCase(key);
}
