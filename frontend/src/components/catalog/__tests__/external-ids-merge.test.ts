import { describe, expect, it } from "vitest";

import { externalIdsPayload, rowsFromExternalIds, validateExternalIds, type ExternalIdRow } from "@/components/catalog/external-ids";
import { describeMerge } from "@/components/catalog/merge-dialog";

const row = (key: string, name: string, value: string): ExternalIdRow => ({ key, name, value });

describe("external identifiers", () => {
  it("round-trips API values to rows and back, trimming and dropping blanks", () => {
    const rows = rowsFromExternalIds({ spotify_id: "abc", mlc_song_code: 12345, empty: null });
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ["spotify_id", "abc"],
      ["mlc_song_code", "12345"],
    ]);
    expect(externalIdsPayload([...rows, row("x", "  ", "  "), row("y", " deezer_id ", " 99 ")])).toEqual({
      spotify_id: "abc",
      mlc_song_code: "12345",
      deezer_id: "99",
    });
  });

  it("returns null to clear all identifiers", () => {
    expect(externalIdsPayload([])).toBeNull();
    expect(externalIdsPayload([row("a", "", "")])).toBeNull();
  });

  it("flags missing parts, duplicates (case-insensitive) and long values", () => {
    const errors = validateExternalIds([
      row("a", "spotify_id", ""),
      row("b", "", "value"),
      row("c", "Spotify_ID", "x"),
      row("d", "isrc_alt", "v".repeat(256)),
      row("e", "", ""),
    ]);
    expect(errors).toEqual({
      "a.value": "Enter a value",
      "b.name": "Enter an identifier name",
      "c.name": "This name is already used",
      "d.value": "Use at most 255 characters",
    });
  });
});

describe("merge summary", () => {
  it("describes moved references and filled fields", () => {
    expect(describeMerge({ moved: { ownership_shares: 3, recording_links: 1, contributors: 0 }, filled_fields: ["iswc", "internal_code"] })).toBe(
      "Moved 3 ownership shares, 1 recording links. Filled iswc, internal code from the duplicate.",
    );
    expect(describeMerge({ moved: {}, filled_fields: [] })).toBe("No references needed moving.");
  });
});
