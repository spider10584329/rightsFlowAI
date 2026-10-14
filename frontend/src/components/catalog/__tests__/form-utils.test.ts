import { describe, expect, it } from "vitest";

import { contributorRowErrors, duplicateConflict, formErrorsFrom, internalCodeConflict } from "@/components/catalog/form-utils";
import { validateWork } from "@/components/catalog/work-form";
import { ApiError } from "@/lib/api/errors";

describe("formErrorsFrom", () => {
  it("maps top-level and nested 422 locations", () => {
    const error = new ApiError({
      status: 422,
      code: "validation_failed",
      message: "Request validation failed",
      details: [
        { loc: ["body", "iswc"], message: "Value error, Invalid ISWC (expected T-123.456.789-C with a valid check digit)", type: "value_error" },
        { loc: ["body", "contributors", "0", "party_id"], message: "Field required", type: "missing" },
      ],
    });
    expect(formErrorsFrom(error)).toEqual({
      iswc: "Invalid ISWC (expected T-123.456.789-C with a valid check digit)",
      "contributors.0.party_id": "Field required",
      contributors: "Field required",
    });
  });
});

describe("409 conflicts", () => {
  it("recognises duplicate identifiers with the existing id", () => {
    const error = new ApiError({
      status: 409,
      code: "duplicate_identifier",
      message: "A work with ISWC T0345246801 already exists ('Song', status active). Pass allow_duplicate=true to create it anyway.",
      details: { field: "iswc", existing_id: "abc" },
    });
    expect(duplicateConflict(error)).toEqual({ message: "A work with ISWC T0345246801 already exists ('Song', status active).", field: "iswc", existingId: "abc" });
    expect(internalCodeConflict(error)).toBeNull();
  });

  it("maps duplicate internal codes", () => {
    const error = new ApiError({ status: 409, code: "duplicate_internal_code", message: "Internal code 'W1' is already used in this catalog" });
    expect(internalCodeConflict(error)).toBe("Internal code 'W1' is already used in this catalog");
    expect(duplicateConflict(error)).toBeNull();
  });
});

describe("contributorRowErrors", () => {
  it("flags missing parties and repeated party + role pairs", () => {
    expect(
      contributorRowErrors([
        { key: "1", party_id: "", party_name: "", role: "composer" },
        { key: "2", party_id: "p", party_name: "P", role: "composer" },
        { key: "3", party_id: "p", party_name: "P", role: "composer" },
        { key: "4", party_id: "p", party_name: "P", role: "lyricist" },
      ]),
    ).toEqual({ "1": "Choose a party", "3": "This party already has this role" });
  });
});

describe("validateWork", () => {
  const base = {
    title: "Song",
    alternate_titles: "",
    iswc: "",
    internal_code: "",
    language: "",
    genre: "",
    creation_year: "",
    lyrics_excerpt: "",
    notes: "",
    status: "active" as const,
    verification_status: "unverified" as const,
  };

  it("mirrors backend rules", () => {
    expect(validateWork(base)).toEqual({});
    expect(validateWork({ ...base, title: "  " }).title).toBe("This field is required");
    expect(validateWork({ ...base, iswc: "T-123.456.789-0" }).iswc).toMatch(/Invalid ISWC/);
    expect(validateWork({ ...base, creation_year: "999" }).creation_year).toBeDefined();
    expect(validateWork({ ...base, language: "english" }).language).toBeDefined();
    expect(validateWork({ ...base, language: "pt-BR", iswc: "T-034.524.680-1", creation_year: "2021" })).toEqual({});
  });
});
