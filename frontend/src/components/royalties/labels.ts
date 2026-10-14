import type { BadgeTone } from "@/components/ui/badge";
import { titleCase } from "@/lib/utils";

// --------------------------------------------------------------------------- statements

export const STATEMENT_STATUSES = ["uploaded", "queued", "processing", "processed", "failed", "calculated", "posted"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

const STATEMENT_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  uploaded: { label: "Needs mapping", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  processed: { label: "Processed", tone: "primary" },
  failed: { label: "Failed", tone: "danger" },
  calculated: { label: "Calculated", tone: "accent" },
  posted: { label: "Posted", tone: "success" },
};

export function statementStatus(status: string): { label: string; tone: BadgeTone } {
  return STATEMENT_STATUS[status] ?? { label: titleCase(status), tone: "neutral" };
}

/** Mirrors `MUTABLE_STATUSES` in backend/app/services/royalty_import.py. */
export const STATEMENT_REPROCESSABLE = new Set(["uploaded", "processed", "failed", "calculated"]);
export const STATEMENT_IN_PROGRESS = new Set(["queued", "processing"]);

export const SOURCE_CATEGORY_FALLBACK: Record<string, string> = {
  streaming: "Streaming platforms",
  distributor: "Digital distributors",
  publishing_admin: "Publishing administrators",
  pro: "Performance rights organizations",
  mechanical: "Mechanical royalty sources",
  licensing: "Licensing revenue",
  manual_adjustment: "Manual adjustments",
};

export const RIGHTS_TYPE_FALLBACK: Record<string, string> = {
  performance: "Public performance (work)",
  mechanical: "Mechanical reproduction (work)",
  sync: "Synchronization",
  print: "Print / lyrics (work)",
  master: "Master recording",
  neighbouring: "Neighbouring rights (recording)",
};

export function sourceCategoryLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return SOURCE_CATEGORY_FALLBACK[code] ?? titleCase(code);
}

export function rightsTypeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return titleCase(code);
}

// --------------------------------------------------------------------------- lines

const MATCH_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  matched: { label: "Matched", tone: "success" },
  unmatched: { label: "Unmatched", tone: "warning" },
  ignored: { label: "Ignored", tone: "neutral" },
};

export function matchStatus(status: string): { label: string; tone: BadgeTone } {
  return MATCH_STATUS[status] ?? { label: titleCase(status), tone: "neutral" };
}

const MATCH_METHODS: Record<string, string> = {
  isrc: "ISRC",
  iswc: "ISWC",
  upc: "UPC",
  title_artist: "Title + artist",
  title: "Title only",
  manual: "Manual",
};

export function matchMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return MATCH_METHODS[method] ?? titleCase(method);
}

// --------------------------------------------------------------------------- runs

const RUN_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  calculated: { label: "Calculated", tone: "accent" },
  posted: { label: "Posted", tone: "success" },
  reversed: { label: "Reversed", tone: "warning" },
  discarded: { label: "Discarded", tone: "neutral" },
};

export function runStatus(status: string): { label: string; tone: BadgeTone } {
  return RUN_STATUS[status] ?? { label: titleCase(status), tone: "neutral" };
}

export const ALLOCATION_TYPES = ["payable", "retained", "unallocated"] as const;
export type AllocationType = (typeof ALLOCATION_TYPES)[number];

const ALLOCATION_TYPE: Record<string, { label: string; tone: BadgeTone; description: string }> = {
  payable: { label: "Payable", tone: "success", description: "Owed to an external party and posted to their ledger." },
  retained: { label: "Retained", tone: "info", description: "Kept by your organization (internal parties or contract retention)." },
  unallocated: { label: "Unallocated", tone: "warning", description: "Held until someone resolves the reason below." },
};

export function allocationType(type: string): { label: string; tone: BadgeTone; description: string } {
  return ALLOCATION_TYPE[type] ?? { label: titleCase(type), tone: "neutral", description: "" };
}

/** Plain-language explanation of every allocation reason the engine emits. */
export const REASON_EXPLANATIONS: Record<string, { label: string; explanation: string; action?: string }> = {
  missing_ownership: {
    label: "No ownership registered",
    explanation: "No active ownership share covers this asset, rights type, territory and date.",
    action: "Add ownership shares for the matched recording or work, then recalculate.",
  },
  disputed_ownership: {
    label: "Ownership disputed",
    explanation: "At least one applicable share is disputed. Income is held until a person resolves the dispute.",
    action: "Resolve the dispute in Rights → Conflicts, then recalculate.",
  },
  over_allocated_ownership: {
    label: "Shares exceed 100%",
    explanation: "The applicable shares add up to more than 100%, so the split is ambiguous.",
    action: "Correct the ownership splits, then recalculate.",
  },
  no_controlled_shares: {
    label: "No controlled shares",
    explanation: "Your organization controls none of the applicable shares, so there is no one to allocate to.",
    action: "Check the share's 'controlled' flag or whether this income belongs to you.",
  },
  unassigned_share: {
    label: "Unowned remainder",
    explanation: "Part of the asset has no registered owner (gross-share basis), so that portion is held.",
    action: "Register the missing ownership or confirm the remainder is not yours.",
  },
  non_controlled_share: {
    label: "Not controlled",
    explanation: "This share is not controlled by your organization; the income may be owed elsewhere.",
  },
  internal_party: {
    label: "Internal party",
    explanation: "The share belongs to an internal party, so the money stays with your organization.",
  },
  contract_retention: {
    label: "Contract retention",
    explanation: "The portion above the contract royalty rate is retained by your organization.",
  },
  unmatched_line: {
    label: "Unmatched line",
    explanation: "The statement line is not matched to a recording or work.",
    action: "Match the line on the statement's Lines tab, then recalculate.",
  },
  no_linked_work: {
    label: "Recording has no work",
    explanation: "Work rights (performance, mechanical, print) need a work, but the matched recording is not linked to any work.",
    action: "Link the recording to its work in the catalog, or match the line to a work directly.",
  },
  multiple_linked_works: {
    label: "Several linked works",
    explanation: "The matched recording embodies several works, so work income cannot be split automatically.",
    action: "Match the line to the specific work, then recalculate.",
  },
  recording_required: {
    label: "Recording required",
    explanation: "Master and neighbouring-rights income needs a recording match, but the line is matched to a work.",
    action: "Match the line to a recording, then recalculate.",
  },
};

export function reasonInfo(reason: string | null | undefined): { label: string; explanation: string; action?: string } {
  if (!reason) return { label: "—", explanation: "" };
  return REASON_EXPLANATIONS[reason] ?? { label: titleCase(reason), explanation: "" };
}

// --------------------------------------------------------------------------- anomalies

export const ANOMALY_LABELS: Record<string, string> = {
  duplicate_line: "Possible duplicate line",
  negative_amount: "Negative amount",
  rate_outlier: "Per-unit rate outlier",
  zero_quantity_with_amount: "Money without usage",
  currency_mismatch: "Currency mismatch",
  period_swing: "Large period-over-period swing",
};

export function anomalyLabel(type: string): string {
  return ANOMALY_LABELS[type] ?? titleCase(type);
}

export function severityTone(severity: string): BadgeTone {
  return severity === "high" ? "danger" : severity === "medium" ? "warning" : "info";
}
