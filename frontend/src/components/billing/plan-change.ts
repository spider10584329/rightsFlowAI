import { isApiError } from "@/lib/api/errors";

export interface ExceededLimit {
  limit: string;
  label: string;
  allowed: number;
  current: number;
}

/** Extracts the exceeded limits from a 409 `plan_limits_exceeded` error; null for anything else. */
export function exceededLimits(error: unknown): ExceededLimit[] | null {
  if (!isApiError(error) || error.code !== "plan_limits_exceeded") return null;
  const details = error.details;
  if (!details || typeof details !== "object") return [];
  const raw = (details as { exceeded?: unknown }).exceeded;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const allowed = Number(record.allowed);
    const current = Number(record.current);
    if (!Number.isFinite(allowed) || !Number.isFinite(current)) return [];
    return [{ limit: String(record.limit ?? ""), label: String(record.label ?? record.limit ?? ""), allowed, current }];
  });
}

const LIMIT_ORDER = ["max_users", "max_catalog_items", "max_statement_imports_per_month", "max_ai_requests_per_month", "max_storage_mb"];

export interface LimitComparison {
  key: string;
  current: number | null;
  target: number | null;
  /** "up" when the target allows more, "down" when less. */
  direction: "up" | "down" | "same";
}

/** Compares numeric limits of two plans (null = unlimited). */
export function compareLimits(current: Record<string, unknown>, target: Record<string, unknown>): LimitComparison[] {
  const toLimit = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return LIMIT_ORDER.filter((key) => key in current || key in target).map((key) => {
    const a = toLimit(current[key]);
    const b = toLimit(target[key]);
    let direction: LimitComparison["direction"] = "same";
    if (a !== b) {
      if (b === null) direction = "up";
      else if (a === null) direction = "down";
      else direction = b > a ? "up" : "down";
    }
    return { key, current: a, target: b, direction };
  });
}
