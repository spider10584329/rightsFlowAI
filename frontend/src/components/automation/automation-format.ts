import type { BadgeTone } from "@/components/ui/badge";
import type {
  AutomationCredential,
  AutomationEventStatus,
  AutomationRunStatus,
  CredentialExpiryLevel,
  CredentialState,
  InboxFileOutcome,
  ReviewTask,
} from "@/lib/api/hooks/automation";
import type { Role } from "@/lib/api/types";
import { hasRole } from "@/lib/roles";
import { titleCase } from "@/lib/utils";

// ----------------------------------------------------------------- role gating

export interface AutomationAccess {
  /** Review queue: every member can read it. */
  viewQueue: boolean;
  /** Resolve/dismiss review tasks and request automated reviews. */
  actOnQueue: boolean;
  /** Keys, overview, runs and outbox (all admin-only endpoints). */
  admin: boolean;
}

/** Mirrors the permissions on backend/app/api/v1/automation_admin.py. */
export function automationAccess(role: Role | null | undefined): AutomationAccess {
  return {
    viewQueue: hasRole(role, "viewer"),
    actOnQueue: hasRole(role, "manager"),
    admin: hasRole(role, "admin"),
  };
}

// ----------------------------------------------------------------- labels & tones

export const REVIEW_KIND_LABELS: Record<string, string> = {
  statement_review: "Statement review",
  statement_mapping: "Column mapping",
  ai_metadata: "AI metadata",
  ai_conflict: "Rights conflict",
};

export function reviewKindLabel(kind: string): string {
  return REVIEW_KIND_LABELS[kind] ?? titleCase(kind);
}

export function reviewKindTone(kind: string): BadgeTone {
  switch (kind) {
    case "statement_review":
      return "info";
    case "statement_mapping":
      return "warning";
    case "ai_metadata":
      return "accent";
    case "ai_conflict":
      return "danger";
    default:
      return "neutral";
  }
}

export function credentialStateTone(state: CredentialState): BadgeTone {
  return state === "active" ? "success" : state === "expired" ? "warning" : "danger";
}

// ----------------------------------------------------------------- key expiry & n8n instance binding

export interface ExpiryLevelStyle {
  label: string;
  tone: BadgeTone;
  /** Extra classes for levels that must stand out more than their tone alone (expired keys). */
  className?: string;
  /** True when an admin should act (rotate the key). */
  attention: boolean;
}

const EXPIRY_LEVEL_STYLES: Record<CredentialExpiryLevel, ExpiryLevelStyle> = {
  ok: { label: "OK", tone: "neutral", attention: false },
  warning: { label: "Expires soon", tone: "warning", attention: true },
  critical: { label: "Expires very soon", tone: "danger", attention: true },
  expired: { label: "Expired", tone: "danger", className: "bg-danger-solid text-white ring-danger-solid", attention: true },
  revoked: { label: "Revoked", tone: "neutral", attention: false },
};

export function expiryLevelStyle(level: CredentialExpiryLevel | string | null | undefined): ExpiryLevelStyle {
  return EXPIRY_LEVEL_STYLES[(level ?? "ok") as CredentialExpiryLevel] ?? { label: titleCase(String(level)), tone: "neutral", attention: false };
}

/** The backend already shortens instance ids ("abcd1234…"); this keeps any longer value to 8 characters. */
export function shortInstanceId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/…$/, "");
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : value;
}

/** Releasing only makes sense for a key that is bound and not revoked. */
export function canReleaseInstance(credential: Pick<AutomationCredential, "bound_instance" | "state">): boolean {
  return Boolean(credential.bound_instance) && credential.state !== "revoked";
}

// ----------------------------------------------------------------- incidents

export function incidentStatusTone(status: string): BadgeTone {
  return status === "open" ? "danger" : status === "resolved" ? "success" : "neutral";
}

export function incidentCategoryLabel(category: string): string {
  return titleCase(category);
}

// ----------------------------------------------------------------- statement processing

export const STATEMENT_STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  retry_waiting: "Retry scheduled",
  failed: "Failed",
  needs_manual_review: "Needs manual review",
  awaiting_mapping: "Awaiting mapping",
};

export function statementStateLabel(state: string): string {
  return STATEMENT_STATE_LABELS[state] ?? titleCase(state);
}

export function statementStateTone(state: string): BadgeTone {
  switch (state) {
    case "completed":
      return "success";
    case "pending":
    case "processing":
      return "info";
    case "retry_waiting":
      return "warning";
    case "awaiting_mapping":
      return "accent";
    case "failed":
    case "needs_manual_review":
      return "danger";
    default:
      return "neutral";
  }
}

/** Manual retry is offered where automation stopped trying (backend: manager+). */
export function canRetryStatementState(state: string): boolean {
  return state === "needs_manual_review" || state === "failed";
}

const ERROR_CATEGORY_LABELS: Record<string, string> = {
  invalid_input: "Invalid file or mapping",
  transient: "Temporary error",
  processing_error: "Processing error",
};

export function errorCategoryLabel(category: string | null | undefined): string | null {
  if (!category) return null;
  return ERROR_CATEGORY_LABELS[category] ?? titleCase(category);
}

export function statementPath(statementId: string): string {
  return `/royalties/statements/${encodeURIComponent(statementId)}`;
}

/** The upload wizard's mapping step, where a person confirms the column mapping. */
export function statementMappingPath(statementId: string): string {
  return `/royalties/statements/new?statement=${encodeURIComponent(statementId)}&step=map`;
}

// ----------------------------------------------------------------- inbox files

export function inboxStateTone(state: string): BadgeTone {
  switch (state) {
    case "imported":
      return "success";
    case "duplicate":
      return "info";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/** Human-readable reason for a file outcome: the message when present, else the humanized code. */
export function inboxErrorText(file: Pick<InboxFileOutcome, "error_code" | "error_message">): string | null {
  const message = file.error_message?.trim();
  if (message) return message;
  if (!file.error_code) return null;
  const text = humanize(file.error_code);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function runStatusTone(status: AutomationRunStatus | string): BadgeTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
      return "info";
    case "partial":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function eventStatusTone(status: AutomationEventStatus | string): BadgeTone {
  switch (status) {
    case "completed":
      return "success";
    case "pending":
    case "claimed":
      return "info";
    case "failed":
      return "warning";
    case "dead":
      return "danger";
    default:
      return "neutral";
  }
}

export const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  schedule: "Schedule",
  event: "Event",
  file: "File drop",
  error_handler: "Error handler",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? titleCase(trigger);
}

export function graceLabel(hours: number): string {
  if (hours === 0) return "Immediately";
  if (hours % 24 === 0) return hours === 24 ? "After 24 hours" : `After ${hours / 24} days`;
  return `After ${hours} hours`;
}

/** Compact "45s" / "12m" / "3h 5m" / "2d 4h" label for an age in seconds. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Pretty, read-only JSON for run summaries. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export const SETUP_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts\\setup-n8n-automation.ps1 -Token <key>";

// ----------------------------------------------------------------- review task details

/**
 * Only internal app paths are linked (never `//host` or `javascript:`).
 * The backend builds party links as `/catalog/partys/{id}`; map them to the
 * real `/catalog/parties/{id}` route.
 */
export function safeAppPath(link: string | null | undefined): string | null {
  if (!link || !link.startsWith("/") || link.startsWith("//") || link.includes("\\")) return null;
  return link.replace(/^\/catalog\/partys\//, "/catalog/parties/");
}

export interface ReviewTaskSummary {
  /** Short human-readable findings, most important first. */
  lines: string[];
  /** Badge text when the task carries AI output, e.g. "AI-generated, pending approval". */
  aiNote: string | null;
  /** Free-text note the automation attached (e.g. advisory disclaimer). */
  note: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

function humanize(code: string): string {
  return code.replace(/[_-]+/g, " ").trim();
}

const AI_OUTCOME_LABELS: Record<string, string> = {
  ai_unavailable: "AI is not available on this plan or server",
  ai_limit_reached: "AI usage limit reached",
  ai_error: "The AI provider returned an error",
};

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Turns a review task's `details` JSON into a few readable lines. Tolerates missing or unexpected fields. */
export function summarizeReviewTask(task: Pick<ReviewTask, "kind" | "details">): ReviewTaskSummary {
  const details = record(task.details);
  const lines: string[] = [];
  let aiNote: string | null = null;
  const note = str(details.note);

  switch (task.kind) {
    case "statement_review": {
      const lineCounts = record(details.lines);
      const held = Array.isArray(details.held) ? details.held.map(record) : [];
      if (details.status === "failed") lines.push("The statement import failed");
      if (num(lineCounts.unmatched)) lines.push(count(num(lineCounts.unmatched), "unmatched line"));
      if (num(lineCounts.invalid)) lines.push(count(num(lineCounts.invalid), "invalid line"));
      const heldTotal = held.reduce((sum, item) => sum + num(item.count), 0);
      if (held.length > 0) {
        const reasons = held
          .filter((item) => str(item.reason))
          .map((item) => `${humanize(String(item.reason))} (${num(item.count).toLocaleString()})`)
          .join(", ");
        lines.push(`${count(heldTotal, "line")} held for review${reasons ? `: ${reasons}` : ""}`);
      }
      if (num(details.import_errors)) lines.push(count(num(details.import_errors), "import error"));
      const calcError = str(details.calculation_error);
      if (calcError) lines.push(`Calculation could not complete (${humanize(calcError)})`);
      if (details.other_currencies === true) lines.push("Contains lines in other currencies");
      if (lines.length === 0 && num(lineCounts.matched)) lines.push(`${count(num(lineCounts.matched), "matched line")}, nothing held`);
      lines.push("Nothing has been posted");
      break;
    }
    case "statement_mapping": {
      const reason = str(details.reason);
      lines.push(reason ?? "The statement's columns could not be mapped automatically");
      const adapter = str(details.adapter);
      if (adapter) lines.push(`Format: ${humanize(adapter)}`);
      break;
    }
    case "ai_metadata": {
      const suggestions = strings(details.suggestion_ids);
      const fields = strings(details.proposed_fields);
      const issues = Array.isArray(details.deterministic_issues) ? details.deterministic_issues.map(record) : [];
      if (suggestions.length > 0) {
        lines.push(`${count(suggestions.length, "AI suggestion")}${fields.length ? ` for ${fields.map(humanize).join(", ")}` : ""}`);
      }
      if (issues.length > 0) {
        const messages = issues.map((issue) => str(issue.message)).filter((m): m is string => Boolean(m));
        lines.push(`${count(issues.length, "validation issue")}${messages.length ? `: ${truncate(messages.slice(0, 3).join("; "), 160)}` : ""}`);
      }
      const outcome = str(details.outcome);
      if (outcome && AI_OUTCOME_LABELS[outcome]) lines.push(AI_OUTCOME_LABELS[outcome]);
      if (details.ai_generated === true || suggestions.length > 0) aiNote = "AI-generated, pending approval";
      break;
    }
    case "ai_conflict": {
      const type = str(details.conflict_type);
      const severity = str(details.severity);
      if (type || severity) lines.push([type ? titleCase(type) : null, severity ? `${humanize(severity)} severity` : null].filter(Boolean).join(" · "));
      const summary = str(details.ai_summary) ?? str(details.system_explanation);
      if (summary) lines.push(truncate(summary));
      const steps = strings(details.suggested_next_steps);
      if (steps.length > 0) lines.push(`${count(steps.length, "suggested next step")}`);
      const outcome = str(details.outcome);
      if (outcome && AI_OUTCOME_LABELS[outcome]) lines.push(AI_OUTCOME_LABELS[outcome]);
      if (details.ai_generated === true) aiNote = "AI-generated, advisory only";
      break;
    }
    default: {
      for (const [key, value] of Object.entries(details).slice(0, 4)) {
        if (key === "note") continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") lines.push(`${titleCase(key)}: ${String(value)}`);
      }
      if (details.ai_generated === true) aiNote = "AI-generated, pending approval";
    }
  }
  return { lines, aiNote, note };
}
