/**
 * Exact decimal helpers for money and percentages.
 *
 * The backend sends every amount as an exact decimal string (8 decimal
 * places for royalty amounts). These helpers never use floating point
 * arithmetic: sums, differences and comparisons use BigInt on scaled
 * integers, and display formatting passes the decimal *string* to
 * `Intl.NumberFormat` (which formats strings exactly in modern runtimes).
 */

export interface ScaledDecimal {
  /** The value multiplied by 10^scale. */
  units: bigint;
  /** Number of fractional digits represented in `units`. */
  scale: number;
}

const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?$/;
const TEN = BigInt(10);
const ZERO = BigInt(0);

/** Parses `"-1,234.50"`-free canonical decimals such as `"-1234.50"`. Returns null for anything else. */
export function parseDecimal(value: string | null | undefined): ScaledDecimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const [, sign, whole = "", fraction = ""] = match;
  if (!whole && !fraction) return null;
  const digits = `${whole || "0"}${fraction}`;
  let units = BigInt(digits);
  if (sign === "-") units = -units;
  return { units, scale: fraction.length };
}

function pow10(exponent: number): bigint {
  let result = BigInt(1);
  for (let index = 0; index < exponent; index += 1) result *= TEN;
  return result;
}

function rescale(value: ScaledDecimal, scale: number): bigint {
  return value.units * pow10(scale - value.scale);
}

/** Serializes a scaled decimal back into a canonical string (keeps `scale` digits). */
export function decimalToString(value: ScaledDecimal): string {
  const negative = value.units < ZERO;
  const digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function toScaled(value: string | null | undefined): ScaledDecimal {
  const parsed = parseDecimal(value);
  if (!parsed) {
    if (value === null || value === undefined || String(value).trim() === "") return { units: ZERO, scale: 0 };
    throw new Error(`Not a decimal number: ${String(value)}`);
  }
  return parsed;
}

/** Exact sum of decimal strings. `null`/empty values count as zero. */
export function addDecimals(...values: (string | null | undefined)[]): string {
  const parsed = values.map(toScaled);
  const scale = parsed.reduce((max, item) => Math.max(max, item.scale), 0);
  const units = parsed.reduce((sum, item) => sum + rescale(item, scale), ZERO);
  return decimalToString({ units, scale });
}

/** Exact `a - b`. */
export function subtractDecimals(a: string | null | undefined, b: string | null | undefined): string {
  const left = toScaled(a);
  const right = toScaled(b);
  const scale = Math.max(left.scale, right.scale);
  return decimalToString({ units: rescale(left, scale) - rescale(right, scale), scale });
}

/** Exact comparison: -1 when a < b, 0 when equal, 1 when a > b. */
export function compareDecimals(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const left = toScaled(a);
  const right = toScaled(b);
  const scale = Math.max(left.scale, right.scale);
  const diff = rescale(left, scale) - rescale(right, scale);
  return diff < ZERO ? -1 : diff > ZERO ? 1 : 0;
}

export function decimalSign(value: string | null | undefined): -1 | 0 | 1 {
  return compareDecimals(value, "0");
}

export function isZeroDecimal(value: string | null | undefined): boolean {
  return decimalSign(value) === 0;
}

export function negateDecimal(value: string): string {
  const parsed = toScaled(value);
  return decimalToString({ units: -parsed.units, scale: parsed.scale });
}

export function absDecimal(value: string): string {
  return decimalSign(value) < 0 ? negateDecimal(value) : decimalToString(toScaled(value));
}

/** Removes insignificant trailing zeros: `"12.50000000"` → `"12.5"`, `"3.00"` → `"3"`. */
export function trimDecimal(value: string): string {
  const parsed = parseDecimal(value);
  if (!parsed) return value;
  const text = decimalToString(parsed);
  if (!text.includes(".")) return text === "-0" ? "0" : text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

// --------------------------------------------------------------------------- display

export type MoneyPrecision = "standard" | "exact";

export interface FormatMoneyOptions {
  /**
   * `standard` rounds to the currency's minor unit (display only).
   * `exact` shows every significant digit up to 8 decimal places.
   */
  precision?: MoneyPrecision;
  /** `always` prefixes positive values with "+" (adjustments, deltas). */
  signDisplay?: "auto" | "always" | "exceptZero";
  /** Render the ISO code instead of the currency symbol. */
  currencyDisplay?: "symbol" | "code" | "narrowSymbol";
  locale?: string;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(key: string, build: () => Intl.NumberFormat): Intl.NumberFormat {
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = build();
    formatterCache.set(key, cached);
  }
  return cached;
}

/**
 * Formats an exact decimal string as money for display. The string itself is
 * handed to `Intl.NumberFormat` (no float conversion). Unknown currency codes
 * fall back to `"<amount> <code>"`.
 */
export function formatMoney(
  amount: string | null | undefined,
  currency: string | null | undefined,
  options: FormatMoneyOptions = {},
): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const parsed = parseDecimal(amount);
  if (!parsed) return String(amount);
  const canonical = decimalToString(parsed) as `${number}`;
  const { precision = "standard", signDisplay = "auto", currencyDisplay = "symbol", locale } = options;
  const code = (currency ?? "").toUpperCase();
  try {
    if (!/^[A-Z]{3}$/.test(code)) throw new RangeError("invalid currency");
    const key = `m|${locale ?? ""}|${code}|${precision}|${signDisplay}|${currencyDisplay}`;
    const fmt = formatter(key, () => {
      const base = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay });
      const minor = base.resolvedOptions().minimumFractionDigits ?? 2;
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        currencyDisplay,
        signDisplay,
        minimumFractionDigits: minor,
        maximumFractionDigits: precision === "exact" ? Math.max(8, minor) : minor,
      });
    });
    return fmt.format(canonical);
  } catch {
    const shown = precision === "exact" ? trimDecimal(canonical) : formatDecimal(canonical, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    const sign = signDisplay !== "auto" && decimalSign(canonical) > 0 ? "+" : "";
    return code ? `${sign}${shown} ${code}` : `${sign}${shown}`;
  }
}

/** Formats a decimal string with grouping (no currency). */
export function formatDecimal(
  value: string | null | undefined,
  options: { maximumFractionDigits?: number; minimumFractionDigits?: number; locale?: string } = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = parseDecimal(value);
  if (!parsed) return String(value);
  const { maximumFractionDigits = 8, minimumFractionDigits = 0, locale } = options;
  const key = `d|${locale ?? ""}|${minimumFractionDigits}|${maximumFractionDigits}`;
  const fmt = formatter(key, () => new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits }));
  return fmt.format(decimalToString(parsed) as `${number}`);
}

/** `"33.33333333"` → `"33.33333333%"`, `"50.0000"` → `"50%"`. */
export function formatPercent(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${formatDecimal(value, { maximumFractionDigits: 8 })}%`;
}

/**
 * Totals per currency for rows that each carry a currency (exact sums).
 * Returns entries sorted by currency code.
 */
export function totalsByCurrency<T>(rows: readonly T[], amount: (row: T) => string | null | undefined, currency: (row: T) => string | null | undefined): [string, string][] {
  const totals = new Map<string, string>();
  for (const row of rows) {
    const code = (currency(row) ?? "").toUpperCase() || "—";
    totals.set(code, addDecimals(totals.get(code) ?? "0", amount(row) ?? "0"));
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// --------------------------------------------------------------------------- input validation

export interface AmountRules {
  allowNegative?: boolean;
  allowZero?: boolean;
  /** Maximum fractional digits accepted by the backend field (8 for ledger, 2 for payouts). */
  maxDecimals?: number;
  /** Total significant digits (backend `max_digits`, default 20). */
  maxDigits?: number;
  required?: boolean;
}

/** Strips spaces and thousands separators typed by users ("1,234.50" → "1234.50"). */
export function normalizeAmountInput(input: string): string {
  return input.trim().replace(/[\s,_]/g, "");
}

/**
 * Validates a typed amount against the backend rules. Returns an error
 * message, or null when valid. Validation is purely textual (no floats).
 */
export function validateAmount(input: string, rules: AmountRules = {}): string | null {
  const { allowNegative = false, allowZero = false, maxDecimals = 8, maxDigits = 20, required = true } = rules;
  const text = normalizeAmountInput(input);
  if (!text) return required ? "Enter an amount" : null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return "Enter a number such as 1250.00";
  const parsed = parseDecimal(text);
  if (!parsed) return "Enter a number such as 1250.00";
  const [, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  if (fraction.length > maxDecimals) return maxDecimals === 0 ? "Use whole numbers only" : `Use at most ${maxDecimals} decimal places`;
  const wholeDigits = text.replace(/^[+-]/, "").split(".")[0].replace(/^0+/, "").length;
  if (wholeDigits + maxDecimals > maxDigits) return "Amount is too large";
  const sign = decimalSign(text);
  if (sign < 0 && !allowNegative) return "Amount must be positive";
  if (sign === 0 && !allowZero) return "Amount must not be zero";
  return null;
}
