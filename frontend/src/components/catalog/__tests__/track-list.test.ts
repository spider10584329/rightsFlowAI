import { describe, expect, it } from "vitest";

import { addTrack, moveTrack, normalizeTracks, removeTrack, setTrackDisc, toTrackPayload, totalDuration, trackListProblems, type TrackRow } from "@/components/catalog/track-list";

function row(key: string, disc = 1, track = 0, duration: number | null = 100): TrackRow {
  return { key, recording_id: `rec-${key}`, title: key, version_title: null, artist: null, isrc: null, duration_seconds: duration, disc_number: disc, track_number: track };
}

const positions = (rows: TrackRow[]) => rows.map((r) => `${r.key}:${r.disc_number}-${r.track_number}`);

describe("track list", () => {
  it("renumbers tracks per disc, keeping order within a disc", () => {
    const rows = normalizeTracks([row("a", 2), row("b", 1), row("c", 2), row("d", 1)]);
    expect(positions(rows)).toEqual(["b:1-1", "d:1-2", "a:2-1", "c:2-2"]);
  });

  it("adds a track at the end of the chosen disc", () => {
    let rows = addTrack([], row("a"));
    rows = addTrack(rows, row("b"));
    rows = addTrack(rows, row("c"), 2);
    rows = addTrack(rows, row("d"), 1);
    expect(positions(rows)).toEqual(["a:1-1", "b:1-2", "d:1-3", "c:2-1"]);
  });

  it("removes and closes the gap", () => {
    const rows = removeTrack(normalizeTracks([row("a"), row("b"), row("c")]), "b");
    expect(positions(rows)).toEqual(["a:1-1", "c:1-2"]);
  });

  it("moves within a disc and across disc boundaries", () => {
    const start = normalizeTracks([row("a"), row("b"), row("c", 2), row("d", 2)]);
    expect(positions(moveTrack(start, "b", -1))).toEqual(["b:1-1", "a:1-2", "c:2-1", "d:2-2"]);
    // First track of disc 2 moving up joins the end of disc 1.
    expect(positions(moveTrack(start, "c", -1))).toEqual(["a:1-1", "b:1-2", "c:1-3", "d:2-1"]);
    // Last track of disc 1 moving down starts disc 2.
    expect(positions(moveTrack(start, "b", 1))).toEqual(["a:1-1", "b:2-1", "c:2-2", "d:2-3"]);
    // Ends of the whole list are no-ops.
    expect(positions(moveTrack(start, "a", -1))).toEqual(positions(start));
    expect(positions(moveTrack(start, "d", 1))).toEqual(positions(start));
  });

  it("moves a track to another disc", () => {
    const rows = setTrackDisc(normalizeTracks([row("a"), row("b"), row("c")]), "a", 2);
    expect(positions(rows)).toEqual(["b:1-1", "c:1-2", "a:2-1"]);
  });

  it("produces unique positions and flags repeated recordings", () => {
    const rows = normalizeTracks([row("a"), { ...row("b"), recording_id: "rec-a" }]);
    const problems = trackListProblems(rows);
    expect(problems.errors).toEqual([]);
    expect([...problems.repeatedRecordingKeys].sort()).toEqual(["a", "b"]);
    expect(trackListProblems([row("a", 1, 1), row("b", 1, 1)]).errors).toEqual(["Duplicate track position disc 1 track 1"]);
    expect(toTrackPayload(rows)).toEqual([
      { recording_id: "rec-a", disc_number: 1, track_number: 1 },
      { recording_id: "rec-a", disc_number: 1, track_number: 2 },
    ]);
  });

  it("totals durations only when every track has one", () => {
    expect(totalDuration([row("a"), row("b")])).toBe(200);
    expect(totalDuration([row("a"), row("b", 1, 0, null)])).toBeNull();
  });
});
