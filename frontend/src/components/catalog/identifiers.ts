/**
 * Client-side mirrors of `backend/app/services/identifiers.py` and the
 * validation messages in `backend/app/schemas/catalog.py`, so forms can
 * flag problems before submitting. The backend stays authoritative.
 */

export const IDENTIFIER_MESSAGES = {
  iswc: "Invalid ISWC (expected T-123.456.789-C with a valid check digit)",
  isrc: "Invalid ISRC (expected CC-XXX-YY-NNNNN)",
  upc: "Invalid UPC/EAN (12-14 digits with a valid GS1 check digit)",
  ipi: "Invalid IPI name number (expected 9-11 digits)",
  isni: "Invalid ISNI (16 characters with a valid check character)",
} as const;

export type IdentifierKind = keyof typeof IDENTIFIER_MESSAGES;

/** Removes spaces, dashes and dots and upper-cases (backend `_compact`). */
export function compactIdentifier(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s\-.]/g, "").toUpperCase();
}

const digitsOnly = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

// ----------------------------------------------------------------- ISRC

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function isValidIsrc(value: string | null | undefined): boolean {
  return ISRC_RE.test(compactIdentifier(value));
}

/** `USRC17607839` -> `US-RC1-76-07839`; invalid input is returned compacted. */
export function formatIsrc(value: string | null | undefined): string {
  const compact = compactIdentifier(value);
  if (!ISRC_RE.test(compact)) return compact;
  return `${compact.slice(0, 2)}-${compact.slice(2, 5)}-${compact.slice(5, 7)}-${compact.slice(7)}`;
}

// ----------------------------------------------------------------- ISWC

const ISWC_RE = /^T\d{10}$/;

/** Mod-10 weighted check digit for the nine ISWC body digits. */
export function iswcCheckDigit(nineDigits: string): number {
  let total = 1;
  for (let index = 0; index < 9; index += 1) total += Number(nineDigits[index]) * (index + 1);
  return (10 - (total % 10)) % 10;
}

export function isValidIswc(value: string | null | undefined): boolean {
  const compact = compactIdentifier(value);
  if (!ISWC_RE.test(compact)) return false;
  return iswcCheckDigit(compact.slice(1, 10)) === Number(compact[10]);
}

/** `T1234567894` -> `T-123.456.789-4`; invalid input is returned compacted. */
export function formatIswc(value: string | null | undefined): string {
  const compact = compactIdentifier(value);
  if (!isValidIswc(compact)) return compact;
  return `T-${compact.slice(1, 4)}.${compact.slice(4, 7)}.${compact.slice(7, 10)}-${compact[10]}`;
}

// ----------------------------------------------------------------- UPC / EAN

export function isValidUpc(value: string | null | undefined): boolean {
  const digits = digitsOnly(value);
  if (![12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let total = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    total += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10 === check;
}

// ----------------------------------------------------------------- IPI / ISNI

export function isValidIpi(value: string | null | undefined): boolean {
  const length = digitsOnly(value).length;
  return length >= 9 && length <= 11;
}

export function isValidIsni(value: string | null | undefined): boolean {
  const compact = compactIdentifier(value);
  if (!/^\d{15}[\dX]$/.test(compact)) return false;
  let total = 0;
  for (const char of compact.slice(0, 15)) total = (total + Number(char)) * 2;
  const check = (12 - (total % 11)) % 11;
  return compact[15] === (check === 10 ? "X" : String(check));
}

/** `0000000121032683` -> `0000 0001 2103 2683`. */
export function formatIsni(value: string | null | undefined): string {
  const compact = compactIdentifier(value);
  if (compact.length !== 16) return compact;
  return compact.replace(/(.{4})(?=.)/g, "$1 ");
}

// ----------------------------------------------------------------- dispatch

const VALIDATORS: Record<IdentifierKind, (value: string) => boolean> = {
  iswc: isValidIswc,
  isrc: isValidIsrc,
  upc: isValidUpc,
  ipi: isValidIpi,
  isni: isValidIsni,
};

/** Returns the backend's error message for an invalid identifier, or null when blank/valid. */
export function identifierError(kind: IdentifierKind, value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (text.length > 32) return "Ensure this value has at most 32 characters";
  return VALIDATORS[kind](text) ? null : IDENTIFIER_MESSAGES[kind];
}

/** Display form for an identifier of the given kind. */
export function formatIdentifier(kind: IdentifierKind, value: string | null | undefined): string {
  if (!value) return "";
  if (kind === "iswc") return formatIswc(value);
  if (kind === "isrc") return formatIsrc(value);
  if (kind === "isni") return formatIsni(value);
  return value;
}

// ----------------------------------------------------------------- durations

/** 225 -> "3:45"; 3725 -> "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Parses "3:45", "1:02:05" or plain seconds ("225"). Returns null for blank
 * input and NaN for anything unparseable.
 */
export function parseDuration(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return Number.NaN;
  const [, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) return Number.NaN;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}
