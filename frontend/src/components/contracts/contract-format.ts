/**
 * Contracts helpers: labels, status transitions, expiry display and the
 * AI-analysis review field selection. Pure, unit-tested.
 */
import type { BadgeTone } from "@/components/ui/badge";
import type { ContractAnalysisReview, ContractDetail } from "@/lib/api/hooks/contracts";

export const CONTRACT_TYPES = ["publishing", "administration", "licensing", "distribution", "recording", "producer", "collaboration"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_STATUSES = ["draft", "pending_signature", "active", "expired", "terminated"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "Draft",
  pending_signature: "Pending signature",
  active: "Active",
  expired: "Expired",
  terminated: "Terminated",
};

export function contractStatusLabel(status: string): string {
  return CONTRACT_STATUS_LABELS[status as ContractStatus] ?? status;
}

export function contractStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "success";
    case "pending_signature":
      return "warning";
    case "draft":
      return "info";
    case "expired":
    case "terminated":
      return "danger";
    default:
      return "neutral";
  }
}

export const PARTY_ROLES = ["licensor", "licensee", "publisher", "writer", "administrator", "label", "artist", "producer", "distributor", "other"] as const;
export type ContractPartyRole = (typeof PARTY_ROLES)[number];

export const SOURCE_CATEGORIES: Record<string, string> = {
  streaming: "Streaming platforms",
  distributor: "Digital distributors",
  publishing_admin: "Publishing administrators",
  pro: "Performance rights organizations",
  mechanical: "Mechanical royalty sources",
  licensing: "Licensing revenue",
  manual_adjustment: "Manual adjustments",
};

export const ALL_RIGHTS = ["performance", "mechanical", "sync", "print", "master", "neighbouring"] as const;

/** Mirrors ALLOWED_TRANSITIONS in backend/app/services/contracts.py (the detail response also carries them). */
export const ALLOWED_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["pending_signature", "active", "terminated"],
  pending_signature: ["draft", "active", "terminated"],
  active: ["expired", "terminated"],
  expired: ["active", "terminated"],
  terminated: [],
};

/** Statuses a new contract may start in. */
export const CREATE_STATUSES: readonly ContractStatus[] = ["draft", "pending_signature", "active"];

/**
 * Options for the status select: on create the creatable statuses; on edit
 * the current status plus the transitions the backend allows (`allowed`
 * from the detail response, falling back to the mirrored table).
 */
export function statusOptions(current: string | null, allowed?: readonly string[]): ContractStatus[] {
  if (!current) return [...CREATE_STATUSES];
  const next = (allowed ?? ALLOWED_TRANSITIONS[current as ContractStatus] ?? []).filter((status): status is ContractStatus =>
    (CONTRACT_STATUSES as readonly string[]).includes(status),
  );
  return [current as ContractStatus, ...next.filter((status) => status !== current)];
}

export function isTransitionAllowed(from: string, to: string, allowed?: readonly string[]): boolean {
  if (from === to) return true;
  return (allowed ?? ALLOWED_TRANSITIONS[from as ContractStatus] ?? []).includes(to);
}

// ----------------------------------------------------------------- expiry

export interface ExpiryDisplay {
  label: string;
  tone: BadgeTone;
}

export function expiryDisplay(state: string, days: number | null | undefined, autoRenew?: boolean): ExpiryDisplay {
  if (state === "expired") {
    return { label: days !== null && days !== undefined && days < 0 ? `Expired ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago` : "Expired", tone: "danger" };
  }
  if (state === "upcoming") {
    const when = days === 0 ? "Expires today" : `Expires in ${days} ${days === 1 ? "day" : "days"}`;
    return { label: autoRenew ? `${when} · auto-renews` : when, tone: "warning" };
  }
  if (days === null || days === undefined) return { label: "No end date", tone: "neutral" };
  return { label: days >= 0 ? `${days} days left` : "Past end date", tone: days >= 0 ? "success" : "neutral" };
}

// ----------------------------------------------------------------- money

export function formatMoney(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency}`;
  }
}

/** Money string validation: non-negative, ≤ 8 decimals (backend decimal_places=8). */
export function isValidAmount(value: string): boolean {
  return /^\d{1,12}(\.\d{1,8})?$/.test(value.trim());
}

// ----------------------------------------------------------------- AI analysis review

export const APPLICABLE_FIELDS = [
  "title",
  "contract_type",
  "start_date",
  "end_date",
  "renewal_date",
  "territories",
  "rights_granted",
  "currency",
  "advance_amount",
  "summary",
] as const;
export type ApplicableField = (typeof APPLICABLE_FIELDS)[number];

export const FIELD_LABELS: Record<ApplicableField, string> = {
  title: "Title",
  contract_type: "Contract type",
  start_date: "Start date",
  end_date: "End date",
  renewal_date: "Renewal date",
  territories: "Territories",
  rights_granted: "Rights granted",
  currency: "Currency",
  advance_amount: "Advance",
  summary: "Summary",
};

/** The extracted value for a field (`summary` comes from `term_summary`). */
export function candidateValue(field: ApplicableField, extracted: Record<string, unknown> | null | undefined): unknown {
  if (!extracted) return null;
  return extracted[field === "summary" ? "term_summary" : field] ?? null;
}

export function hasCandidate(field: ApplicableField, extracted: Record<string, unknown> | null | undefined): boolean {
  const value = candidateValue(field, extracted);
  return !(value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0));
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function currentValue(field: ApplicableField, contract: Pick<ContractDetail, ApplicableField>): unknown {
  const value = contract[field] ?? null;
  if (field === "advance_amount" && typeof value === "string") return trimDecimal(value);
  return value;
}

/** "25000.00000000" → "25000", "12.50" → "12.5" (string-only, no float conversion). */
export function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function normalize(field: ApplicableField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return [...value].map((item) => String(item).trim().toLowerCase()).sort().join(",");
  if (field === "advance_amount") {
    const number = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(number) ? String(number) : String(value);
  }
  return String(value).trim().toLowerCase();
}

/** True when the AI candidate differs from what the contract currently has. */
export function differsFromCurrent(field: ApplicableField, extracted: Record<string, unknown> | null | undefined, contract: Pick<ContractDetail, ApplicableField>): boolean {
  return normalize(field, candidateValue(field, extracted)) !== normalize(field, currentValue(field, contract));
}

/** Fields worth pre-selecting: a candidate exists and differs from the current value. Nothing is ever applied without the user ticking it. */
export function selectableFields(extracted: Record<string, unknown> | null | undefined, contract: Pick<ContractDetail, ApplicableField>): ApplicableField[] {
  return APPLICABLE_FIELDS.filter((field) => hasCandidate(field, extracted) && differsFromCurrent(field, extracted, contract));
}

export function buildReviewPayload(decision: "accepted" | "rejected", selected: Iterable<ApplicableField>, notes: string): ContractAnalysisReview {
  const ordered = APPLICABLE_FIELDS.filter((field) => new Set(selected).has(field));
  return {
    decision,
    notes: notes.trim() || null,
    apply_fields: decision === "accepted" ? ordered : [],
  };
}

export function analysisStatusTone(status: string): BadgeTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

export function reviewStatusTone(status: string): BadgeTone {
  if (status === "accepted") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
