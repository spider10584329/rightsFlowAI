import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges conditional class names and resolves Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Backend datetimes are naive UTC (no offset). Treat offset-less ISO strings
 * as UTC so they render correctly in the viewer's time zone.
 */
export function parseApiDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const date = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  const date = parseApiDate(value);
  return date ? dateFormatter.format(date) : "—";
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseApiDate(value);
  return date ? dateTimeFormatter.format(date) : "—";
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "3 hours ago" style label. Call only on the client (depends on the current time). */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = parseApiDate(value);
  if (!date) return "—";
  const seconds = Math.round((date.getTime() - now) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Converts a display name into a URL slug matching the backend pattern. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function titleCase(value: string): string {
  return value
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
