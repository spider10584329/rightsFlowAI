/**
 * Rights module helpers: labels, exact percentage arithmetic (strings in,
 * BigInt micro-units inside, never floats), split totals and validation
 * display. Pure functions, unit-tested in `__tests__/rights-format.test.ts`.
 */
import type { BadgeTone } from "@/components/ui/badge";
import type { AssetType, RightsType, RightsValidationIssue, ShareRole, SplitRule, ValidationResult } from "@/lib/api/hooks/rights";

// ----------------------------------------------------------------- labels

export const WORK_RIGHTS_TYPES: RightsType[] = ["performance", "mechanical", "sync", "print"];
export const RECORDING_RIGHTS_TYPES: RightsType[] = ["master", "neighbouring", "sync"];

export function rightsTypesFor(assetType: AssetType): RightsType[] {
  return assetType === "work" ? WORK_RIGHTS_TYPES : RECORDING_RIGHTS_TYPES;
}

export const RIGHTS_TYPE_LABELS: Record<RightsType, string> = {
  performance: "Performance",
  mechanical: "Mechanical",
  sync: "Synchronization",
  print: "Print / lyrics",
  master: "Master",
  neighbouring: "Neighbouring",
};

export const RIGHTS_TYPE_HINTS: Record<RightsType, string> = {
  performance: "Public performance of the composition",
  mechanical: "Reproduction of the composition",
  sync: "Use alongside visual media",
  print: "Sheet music and lyric reproduction",
  master: "Ownership of the sound recording",
  neighbouring: "Broadcast / public performance of the recording",
};

export function rightsTypeLabel(value: string | null | undefined): string {
  if (!value) return "All rights types";
  return RIGHTS_TYPE_LABELS[value as RightsType] ?? value;
}

export const SHARE_ROLES: ShareRole[] = ["writer", "publisher", "administrator", "sub_publisher", "label", "artist", "producer", "other"];

export const SHARE_ROLE_LABELS: Record<ShareRole, string> = {
  writer: "Writer",
  publisher: "Publisher",
  administrator: "Administrator",
  sub_publisher: "Sub-publisher",
  label: "Label",
  artist: "Artist",
  producer: "Producer",
  other: "Other",
};

export function roleLabel(value: string): string {
  return SHARE_ROLE_LABELS[value as ShareRole] ?? value;
}

export const CONFLICT_TYPE_LABELS: Record<string, string> = {
  over_allocation: "Over-allocation",
  under_allocation: "Under-allocation",
  overlapping_claims: "Overlapping claims",
  duplicate_entry: "Duplicate entry",
  missing_ownership: "Missing ownership",
  invalid_metadata: "Invalid metadata",
};

/** One-line plain-language explanation of each issue / conflict type. */
export const CONFLICT_TYPE_EXPLAINERS: Record<string, string> = {
  over_allocation: "The shares for the same rights, territory and period add up to more than the expected total, so more than 100% of income would be paid out.",
  under_allocation: "The shares add up to less than the expected total, so part of the income has no owner.",
  overlapping_claims: "Two shares claim the same role for overlapping territories and dates.",
  duplicate_entry: "The same share was entered more than once, so it is counted twice.",
  missing_ownership: "No active ownership is recorded for a primary rights type, so income cannot be allocated.",
  invalid_metadata: "A share has bad data, such as unknown territories, inverted dates, an archived party or a disputed claim.",
};

export function conflictTypeLabel(value: string): string {
  return CONFLICT_TYPE_LABELS[value] ?? value.replace(/_/g, " ");
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "medium":
      return "info";
    default:
      return "neutral";
  }
}

export const CONFLICT_STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;

export function conflictStatusTone(status: string): BadgeTone {
  switch (status) {
    case "open":
      return "danger";
    case "acknowledged":
      return "warning";
    case "resolved":
      return "success";
    default:
      return "neutral";
  }
}

/** Lifecycle actions available from a conflict status (mirrors CONFLICT_TRANSITIONS in the backend). */
export function conflictActionsFor(status: string): ("acknowledge" | "resolve" | "dismiss" | "reopen")[] {
  switch (status) {
    case "open":
      return ["acknowledge", "resolve", "dismiss"];
    case "acknowledged":
      return ["resolve", "dismiss", "reopen"];
    case "resolved":
    case "dismissed":
      return ["reopen"];
    default:
      return [];
  }
}

export function conflictActionNeedsNotes(action: string): boolean {
  return action === "resolve" || action === "dismiss";
}

export function shareStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "success";
    case "disputed":
      return "danger";
    case "superseded":
      return "info";
    default:
      return "neutral";
  }
}

export function verificationTone(status: string): BadgeTone {
  if (status === "verified") return "success";
  if (status === "disputed") return "danger";
  return "warning";
}

// ----------------------------------------------------------------- exact percentages

const SCALE_DIGITS = 6;
const SCALE = BigInt(10 ** SCALE_DIGITS);
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,6})?$/;

/** Parses "33.333333" into micro-percent units (BigInt). Returns null when not a valid 0–999 decimal with ≤ 6 places. */
export function parsePercent(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  const normalized = text.startsWith(".") ? `0${text}` : text;
  if (!PERCENT_PATTERN.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, "0"));
}

/** Micro-units back to a trimmed decimal string ("100", "33.333333", "12.5"). */
export function microToPercentString(micro: bigint): string {
  const negative = micro < BigInt(0);
  const abs = negative ? -micro : micro;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

/** Sum of percentage strings; invalid entries are counted, not added. */
export function sumPercents(values: (string | null | undefined)[]): { total: bigint; invalid: number } {
  let total = BigInt(0);
  let invalid = 0;
  for (const value of values) {
    const parsed = parsePercent(value);
    if (parsed === null) invalid += 1;
    else total += parsed;
  }
  return { total, invalid };
}

const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

/** Display only: "33.333333%". Accepts the backend's decimal strings. */
export function formatPercent(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return `${value}%`;
  return `${percentFormatter.format(number)}%`;
}

// ----------------------------------------------------------------- split rules

export interface EffectiveRule {
  expectedTotal: string;
  tolerance: string;
  allowUnderAllocation: boolean;
  enforcement: "warn" | "block";
  scope: string;
  ruleId: string | null;
}

export const DEFAULT_RULE: EffectiveRule = {
  expectedTotal: "100",
  tolerance: "0.01",
  allowUnderAllocation: false,
  enforcement: "warn",
  scope: "Default rule (100% ± 0.01%, warn)",
  ruleId: null,
};

/**
 * Most specific rule for (asset type, rights type, country), mirroring the
 * backend RuleBook: exact country > WORLD > all territories > default.
 */
export function resolveRule(
  rules: readonly Pick<SplitRule, "id" | "asset_type" | "rights_type" | "territory" | "expected_total" | "tolerance" | "allow_under_allocation" | "enforcement">[],
  assetType: AssetType,
  rightsType: string,
  country?: string | null,
): EffectiveRule {
  const candidates = rules.filter((rule) => rule.asset_type === assetType && rule.rights_type === rightsType);
  const match =
    (country && country !== "WORLD" ? candidates.find((rule) => rule.territory === country) : undefined) ??
    candidates.find((rule) => rule.territory === "WORLD") ??
    candidates.find((rule) => !rule.territory);
  if (!match) return DEFAULT_RULE;
  return {
    expectedTotal: trimPercent(match.expected_total),
    tolerance: trimPercent(match.tolerance),
    allowUnderAllocation: match.allow_under_allocation,
    enforcement: match.enforcement === "block" ? "block" : "warn",
    scope: `Rule for ${match.territory ?? "all territories"}`,
    ruleId: match.id,
  };
}

export type TotalStatus = "ok" | "over" | "under" | "under_allowed" | "invalid";

/** Same comparison as the backend `allocation_status`. */
export function totalStatus(total: bigint, rule: Pick<EffectiveRule, "expectedTotal" | "tolerance" | "allowUnderAllocation">): TotalStatus {
  const expected = parsePercent(rule.expectedTotal);
  const tolerance = parsePercent(rule.tolerance) ?? BigInt(0);
  if (expected === null) return "invalid";
  if (total > expected + tolerance) return "over";
  if (total < expected - tolerance) return rule.allowUnderAllocation ? "under_allowed" : "under";
  return "ok";
}

export const TOTAL_STATUS_LABELS: Record<TotalStatus, string> = {
  ok: "Fully allocated",
  over: "Over-allocated",
  under: "Under-allocated",
  under_allowed: "Under-allocated (allowed)",
  invalid: "Check values",
};

export function totalStatusTone(status: string): BadgeTone {
  switch (status) {
    case "ok":
      return "success";
    case "over":
      return "danger";
    case "under":
      return "warning";
    case "under_allowed":
      return "info";
    default:
      return "neutral";
  }
}

// ----------------------------------------------------------------- splits editor totals

export interface SplitRowScope {
  share_percent: string;
  territories: string[];
  excluded_territories: string[];
  effective_from: string;
  effective_to: string;
}

function scopeKey(row: SplitRowScope): string {
  return JSON.stringify([
    [...row.territories].sort(),
    [...row.excluded_territories].sort(),
    row.effective_from || null,
    row.effective_to || null,
  ]);
}

export interface RunningTotal {
  total: bigint;
  totalLabel: string;
  invalid: number;
  /** True when every row has the same territory scope and dates, so the single total is exact. */
  uniformScope: boolean;
  status: TotalStatus;
  /** Remaining percentage to reach the expected total (negative when over). */
  remaining: string;
}

/**
 * Live total for the splits editor. When rows cover different territories or
 * dates the plain sum is only indicative; per-territory totals come from the
 * backend dry-run validation.
 */
export function runningTotal(rows: SplitRowScope[], rule: Pick<EffectiveRule, "expectedTotal" | "tolerance" | "allowUnderAllocation"> = DEFAULT_RULE): RunningTotal {
  const { total, invalid } = sumPercents(rows.map((row) => row.share_percent));
  const keys = new Set(rows.map(scopeKey));
  const expected = parsePercent(rule.expectedTotal) ?? BigInt(0);
  return {
    total,
    totalLabel: microToPercentString(total),
    invalid,
    uniformScope: keys.size <= 1,
    status: invalid > 0 ? "invalid" : rows.length === 0 ? "under" : totalStatus(total, rule),
    remaining: microToPercentString(expected - total),
  };
}

// ----------------------------------------------------------------- validation display

export interface ValidationDisplay {
  tone: "success" | "warning" | "danger";
  headline: string;
  detail: string;
  blocking: RightsValidationIssue[];
  warnings: RightsValidationIssue[];
  canSave: boolean;
}

/** Turns a dry-run / write validation result into block-vs-warn messaging. */
export function describeValidation(result: Pick<ValidationResult, "valid" | "blocked" | "issues">): ValidationDisplay {
  const blocking = result.issues.filter((issue) => issue.blocking);
  const warnings = result.issues.filter((issue) => !issue.blocking);
  if (blocking.length > 0) {
    return {
      tone: "danger",
      headline: `${blocking.length} blocking ${blocking.length === 1 ? "issue" : "issues"}: saving is not allowed`,
      detail: "A split rule set to “block” rejects this set. Fix the highlighted totals before saving.",
      blocking,
      warnings,
      canSave: false,
    };
  }
  if (warnings.length > 0) {
    return {
      tone: "warning",
      headline: `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}: you can still save`,
      detail: "These are recorded as rights conflicts for review after saving.",
      blocking,
      warnings,
      canSave: true,
    };
  }
  return { tone: "success", headline: "No issues found", detail: "Totals match the split rules for every territory and period.", blocking, warnings, canSave: true };
}

/** Plain-language one-liner for a validation issue (falls back to the backend message). */
export function issueSummary(issue: Pick<RightsValidationIssue, "type" | "title" | "blocking" | "enforcement">): string {
  const prefix = issue.blocking ? "Blocks saving" : issue.enforcement === "warn" ? "Warning" : "Needs review";
  return `${prefix} · ${conflictTypeLabel(issue.type)}: ${issue.title}`;
}

// ----------------------------------------------------------------- dates

/** Today's date as YYYY-MM-DD in the viewer's time zone. Client-only. */
export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function periodLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return "All dates";
  if (!from) return `Until ${to}`;
  if (!to) return `From ${from}`;
  return `${from} → ${to}`;
}

export function territoryLabel(territories: string[] | null | undefined, excluded: string[] | null | undefined): string {
  const list = territories && territories.length > 0 ? territories : ["WORLD"];
  const base = list.length > 6 ? `${list.slice(0, 6).join(", ")} +${list.length - 6}` : list.join(", ");
  return excluded && excluded.length > 0 ? `${base} excl. ${excluded.join(", ")}` : base;
}

/** "50.500000" → "50.5" for editable inputs (exact, no float conversion). */
export function trimPercent(value: string | null | undefined): string {
  const parsed = parsePercent(value);
  return parsed === null ? (value ?? "") : microToPercentString(parsed);
}
