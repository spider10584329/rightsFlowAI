/**
 * Display helpers for dashboard figures.
 *
 * Money arrives from the backend as exact decimal strings. These helpers
 * convert with `Number()` for DISPLAY and chart geometry only; totals are
 * always taken from the backend, never summed here. No FX conversion is
 * done anywhere: each amount stays in its own currency.
 */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}|${compact}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        currencyDisplay: "code",
        ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      });
    } catch {
      // Unknown currency code: fall back to a plain number with the code appended by the caller.
      formatter = new Intl.NumberFormat(undefined, compact ? { notation: "compact", maximumFractionDigits: 1 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

/** Parses a decimal string for display/geometry. Returns null for missing or invalid values. */
export function toDisplayNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "USD 1,234.50" (or "USD 1.2K" compact). Invalid input renders "—". */
export function formatMoney(amount: string | number | null | undefined, currency: string, options: { compact?: boolean } = {}): string {
  const parsed = toDisplayNumber(amount);
  if (parsed === null) return "—";
  // Compact notation only pays off from 1,000 up; smaller amounts keep their cents.
  const formatter = moneyFormatter(currency, Boolean(options.compact) && Math.abs(parsed) >= 1000);
  const text = formatter.format(parsed);
  // Normalise the non-breaking space Intl inserts after the code so tests and copy are stable.
  const normalised = text.replace(/ /g, " ");
  return normalised.includes(currency) ? normalised : `${currency} ${normalised}`;
}

const integerFormatter = new Intl.NumberFormat();
const compactFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? integerFormatter.format(value) : "—";
}

export function formatCompact(value: number): string {
  return Math.abs(value) >= 1000 ? compactFormatter.format(value) : integerFormatter.format(value);
}

/** Formats a percentage string ("42.50") as "42.5%". */
export function formatPercent(value: string | number | null | undefined, digits = 1): string {
  const parsed = toDisplayNumber(value);
  if (parsed === null) return "—";
  return `${parsed.toLocaleString(undefined, { maximumFractionDigits: digits })}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03" -> { short: "Mar", long: "Mar 2026" }. */
export function monthLabel(month: string): { short: string; long: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return { short: month, long: month };
  const index = Number(match[2]) - 1;
  const name = MONTHS[index] ?? match[2];
  return { short: name, long: `${name} ${match[1]}` };
}

export interface MoneyPoint {
  key: string;
  label: string;
  longLabel: string;
  /** Display/geometry only. */
  value: number;
  /** Exact backend string. */
  amount: string;
}

/** Monthly series from `royalties-over-time` -> chart points. */
export function toMonthlyPoints(series: { month: string; amount: string }[]): MoneyPoint[] {
  return series.map((point) => {
    const label = monthLabel(point.month);
    return { key: point.month, label: label.short, longLabel: label.long, value: toDisplayNumber(point.amount) ?? 0, amount: point.amount };
  });
}

export interface RankedItem {
  key: string;
  label: string;
  sublabel?: string | null;
  href?: string;
  value: number;
  amount: string;
  /** 0-100 width relative to the largest item, for inline bars. */
  share: number;
}

/**
 * Ranked bars. The backend already orders items; we keep its order and scale
 * widths to the largest absolute value. Negative amounts (adjustments) get a
 * zero-width bar but keep their exact text.
 */
export function toRankedItems<T>(
  items: T[],
  pick: (item: T) => { key: string; label: string; sublabel?: string | null; href?: string; amount: string },
): RankedItem[] {
  const mapped = items.map((item) => {
    const picked = pick(item);
    return { ...picked, value: toDisplayNumber(picked.amount) ?? 0 };
  });
  const max = mapped.reduce((acc, item) => Math.max(acc, item.value), 0);
  return mapped.map((item) => ({ ...item, share: max > 0 && item.value > 0 ? (item.value / max) * 100 : 0 }));
}

/**
 * Currency choices for the switcher: the organization's primary currency
 * first, then every other currency that has reported data, de-duplicated
 * and sorted.
 */
export function currencyOptions(primary: string, ...lists: ({ currency: string }[] | null | undefined)[]): string[] {
  const others = new Set<string>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (entry.currency && entry.currency !== primary) others.add(entry.currency);
    }
  }
  return [primary, ...Array.from(others).sort()];
}

/** The selected currency if it is one of the options, else the primary currency. */
export function resolveCurrency(requested: string | null | undefined, options: string[], primary: string): string {
  const normalised = (requested ?? "").trim().toUpperCase();
  return normalised && options.includes(normalised) ? normalised : primary;
}

/** "Also: EUR 120.00 · GBP 5.00" for amounts held in other currencies (never converted). */
export function otherCurrenciesNote(list: { currency: string; amount: string }[] | null | undefined): string | null {
  const nonZero = (list ?? []).filter((entry) => toDisplayNumber(entry.amount) !== 0);
  if (nonZero.length === 0) return null;
  return nonZero.map((entry) => formatMoney(entry.amount, entry.currency)).join(" · ");
}

/** True when the decimal string is exactly zero (or missing). */
export function isZeroAmount(amount: string | null | undefined): boolean {
  const parsed = toDisplayNumber(amount);
  return parsed === null || parsed === 0;
}

/** Catalog detail route for an entity type returned by the backend. */
export function entityHref(entityType: string | null | undefined, id: string | null | undefined): string | null {
  if (!entityType || !id) return null;
  switch (entityType) {
    case "work":
      return `/catalog/works/${id}`;
    case "recording":
      return `/catalog/recordings/${id}`;
    case "release":
      return `/catalog/releases/${id}`;
    case "party":
      return `/catalog/parties/${id}`;
    case "contract":
      return `/contracts/${id}`;
    case "statement":
      return `/royalties/statements/${id}`;
    case "conflict":
      return `/rights/conflicts`;
    default:
      return null;
  }
}
