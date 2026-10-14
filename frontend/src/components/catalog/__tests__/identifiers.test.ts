import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatIsni,
  formatIsrc,
  formatIswc,
  identifierError,
  IDENTIFIER_MESSAGES,
  isValidIpi,
  isValidIsni,
  isValidIsrc,
  isValidIswc,
  isValidUpc,
  iswcCheckDigit,
  parseDuration,
} from "@/components/catalog/identifiers";

describe("ISWC", () => {
  it("validates the mod-10 check digit (backend example T-034.524.680-1)", () => {
    expect(iswcCheckDigit("034524680")).toBe(1);
    expect(isValidIswc("T-034.524.680-1")).toBe(true);
    expect(isValidIswc("T0345246801")).toBe(true);
    expect(isValidIswc("t 034 524 680 1")).toBe(true);
    expect(isValidIswc("T-034.524.680-2")).toBe(false);
    expect(isValidIswc("T-123.456.789")).toBe(false);
    expect(isValidIswc("")).toBe(false);
  });

  it("formats compact values as T-123.456.789-C", () => {
    expect(formatIswc("T0345246801")).toBe("T-034.524.680-1");
    expect(formatIswc("t-034.524.680-2")).toBe("T0345246802");
  });
});

describe("ISRC", () => {
  it("requires CC + 3 alphanumerics + 7 digits", () => {
    expect(isValidIsrc("USRC17607839")).toBe(true);
    expect(isValidIsrc("US-RC1-76-07839")).toBe(true);
    expect(isValidIsrc("usrc17607839")).toBe(true);
    expect(isValidIsrc("USRC1760783")).toBe(false);
    expect(isValidIsrc("1SRC17607839")).toBe(false);
    expect(isValidIsrc("USRC1760783X")).toBe(false);
  });

  it("formats as CC-XXX-YY-NNNNN", () => {
    expect(formatIsrc("usrc17607839")).toBe("US-RC1-76-07839");
  });
});

describe("UPC / IPI / ISNI", () => {
  it("checks the GS1 check digit for 12-14 digits", () => {
    expect(isValidUpc("012345678905")).toBe(true);
    expect(isValidUpc("0012345678905")).toBe(true);
    expect(isValidUpc("012345678906")).toBe(false);
    expect(isValidUpc("12345")).toBe(false);
  });

  it("accepts 9-11 digit IPI numbers", () => {
    expect(isValidIpi("00052210040")).toBe(true);
    expect(isValidIpi("52210040")).toBe(false);
    expect(isValidIpi("123456789012")).toBe(false);
  });

  it("validates the ISNI MOD 11-2 check character", () => {
    expect(isValidIsni("0000000121032683")).toBe(true);
    expect(isValidIsni("0000 0001 2103 2683")).toBe(true);
    expect(isValidIsni("0000000121032684")).toBe(false);
    expect(formatIsni("0000000121032683")).toBe("0000 0001 2103 2683");
  });
});

describe("identifierError", () => {
  it("returns null for blank or valid values and the backend message otherwise", () => {
    expect(identifierError("iswc", "")).toBeNull();
    expect(identifierError("iswc", "  ")).toBeNull();
    expect(identifierError("iswc", "T-034.524.680-1")).toBeNull();
    expect(identifierError("iswc", "T-034.524.680-9")).toBe(IDENTIFIER_MESSAGES.iswc);
    expect(identifierError("isrc", "bad")).toBe("Invalid ISRC (expected CC-XXX-YY-NNNNN)");
    expect(identifierError("upc", "x".repeat(40))).toMatch(/at most 32/);
  });
});

describe("durations", () => {
  it("parses m:ss, h:mm:ss and seconds", () => {
    expect(parseDuration("3:45")).toBe(225);
    expect(parseDuration("1:02:05")).toBe(3725);
    expect(parseDuration("225")).toBe(225);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("3:75")).toBeNaN();
    expect(parseDuration("abc")).toBeNaN();
  });

  it("formats seconds", () => {
    expect(formatDuration(225)).toBe("3:45");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("—");
  });
});
