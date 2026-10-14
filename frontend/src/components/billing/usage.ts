/** Usage-meter helpers shared by the billing and AI pages. */

export type MeterTone = "normal" | "warning" | "danger";

/**
 * Bar width for a meter, clamped to 0..100. Prefers the backend's exact
 * percentage string; falls back to used/limit. Unlimited (null limit) -> null.
 */
export function meterPercent(used: number, limit: number | null | undefined, percentage?: string | null): number | null {
  if (limit === null || limit === undefined) return null;
  let raw: number;
  if (percentage !== null && percentage !== undefined && percentage !== "" && Number.isFinite(Number(percentage))) {
    raw = Number(percentage);
  } else if (limit <= 0) {
    raw = used > 0 ? 100 : 0;
  } else {
    raw = (used / limit) * 100;
  }
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

/** Severity of a meter: >=100% (or exceeded) is danger, >=80% warning. */
export function meterTone(percent: number | null, exceeded = false): MeterTone {
  if (exceeded) return "danger";
  if (percent === null) return "normal";
  if (percent >= 100) return "danger";
  if (percent >= 80) return "warning";
  return "normal";
}

/** Text that conveys the meter state without relying on color. */
export function meterStatusText(percent: number | null, exceeded = false): string | null {
  const tone = meterTone(percent, exceeded);
  if (exceeded) return "Over limit";
  if (tone === "danger") return "Limit reached";
  if (tone === "warning") return "Nearing limit";
  return null;
}

export function formatMegabytes(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb.toLocaleString()} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
}

/** Formats a USD cost estimate string with up to 4 decimals (AI costs are tiny). */
export function formatUsd(value: string | null | undefined): string {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) return "—";
  return `USD ${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: parsed !== 0 && Math.abs(parsed) < 1 ? 4 : 2 })}`;
}
