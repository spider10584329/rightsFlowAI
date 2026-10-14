"use client";

import { ArrowDown, ArrowUp, Disc3, ListMusic, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CatalogPicker } from "@/components/catalog/catalog-picker";
import { rowKey } from "@/components/catalog/form-utils";
import { formatDuration, formatIsrc } from "@/components/catalog/identifiers";
import { entityHref } from "@/components/catalog/labels";
import {
  addTrack,
  lastDisc,
  MAX_DISC,
  moveTrack,
  removeTrack,
  setTrackDisc,
  totalDuration,
  trackListProblems,
  type TrackRow,
} from "@/components/catalog/track-list";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ScrollRegion } from "@/components/ui/scroll-region";
import type { Recording } from "@/lib/api/hooks/catalog";
import { cn, pluralize } from "@/lib/utils";

export interface TrackListEditorProps {
  orgId: string;
  rows: TrackRow[];
  onChange: (rows: TrackRow[]) => void;
  serverError?: string;
}

/** Release track list: add recordings by search, reorder, assign discs. */
export function TrackListEditor({ orgId, rows, onChange, serverError }: TrackListEditorProps) {
  const discCount = lastDisc(rows);
  const [targetDisc, setTargetDisc] = useState(1);
  const addDisc = Math.min(Math.max(targetDisc, 1), discCount + 1);
  const { errors, repeatedRecordingKeys } = trackListProblems(rows);
  const runtime = totalDuration(rows);

  const add = (recording: Recording) =>
    onChange(
      addTrack(
        rows,
        {
          key: rowKey("track"),
          recording_id: recording.id,
          title: recording.title,
          version_title: recording.version_title,
          artist: recording.artist,
          isrc: recording.isrc,
          duration_seconds: recording.duration_seconds,
        },
        addDisc,
      ),
    );

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="track-add">Add recording</Label>
          <CatalogPicker
            id="track-add"
            orgId={orgId}
            entity="recording"
            placeholder="Search recordings by title, artist or ISRC"
            onSelect={(item) => add(item as Recording)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="track-add-disc">To disc</Label>
          <NativeSelect id="track-add-disc" value={addDisc} onChange={(event) => setTargetDisc(Number(event.target.value))}>
            {Array.from({ length: Math.min(discCount + 1, MAX_DISC) }, (_, index) => index + 1).map((disc) => (
              <option key={disc} value={disc}>
                {disc > discCount ? `Disc ${disc} (new)` : `Disc ${disc}`}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
          <ListMusic className="size-5 text-fg-subtle" aria-hidden />
          <p className="text-[13px] text-fg-muted">No tracks yet. Search for a recording above to add the first track.</p>
        </div>
      ) : (
        <ScrollRegion className="rounded-lg border border-border">
          <table className="w-full min-w-[36rem] text-[13px]">
            <caption className="sr-only">Track list</caption>
            <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
              <tr>
                <th scope="col" className="w-20 px-3 py-2 font-semibold">
                  Disc
                </th>
                <th scope="col" className="w-12 px-2 py-2 text-right font-semibold">
                  #
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Recording
                </th>
                <th scope="col" className="w-16 px-3 py-2 text-right font-semibold">
                  Time
                </th>
                <th scope="col" className="w-32 px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, index) => {
                const label = `${row.title} (disc ${row.disc_number}, track ${row.track_number})`;
                const firstOfDisc = index === 0 || rows[index - 1].disc_number !== row.disc_number;
                return (
                  <tr key={row.key} className={cn("align-middle", firstOfDisc && index > 0 && "border-t-2 border-t-border-strong")}>
                    <td className="px-3 py-1.5">
                      <Input
                        type="number"
                        min={1}
                        max={MAX_DISC}
                        aria-label={`Disc number for ${row.title}`}
                        className="h-8 w-16 px-2 tabular-nums"
                        value={row.disc_number}
                        onChange={(event) => {
                          const disc = Number(event.target.value);
                          if (Number.isInteger(disc) && disc >= 1) onChange(setTrackDisc(rows, row.key, disc));
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums text-fg">{row.track_number}</td>
                    <td className="px-3 py-1.5">
                      <div className="min-w-0">
                        <Link href={entityHref("recording", row.recording_id)} className="font-medium text-fg hover:text-primary hover:underline" target="_blank">
                          {row.title}
                          {row.version_title ? <span className="text-fg-muted"> ({row.version_title})</span> : null}
                        </Link>
                        <p className="truncate text-xs text-fg-subtle">
                          {[row.artist, row.isrc ? formatIsrc(row.isrc) : null].filter(Boolean).join(" · ") || "No artist or ISRC"}
                          {repeatedRecordingKeys.has(row.key) ? <span className="ml-2 font-medium text-warning-soft-fg">Appears more than once</span> : null}
                        </p>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-fg-muted">{formatDuration(row.duration_seconds)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex justify-end gap-0.5">
                        <IconButton size="xs" label={`Move ${label} up`} icon={<ArrowUp aria-hidden />} disabled={index === 0} onClick={() => onChange(moveTrack(rows, row.key, -1))} />
                        <IconButton
                          size="xs"
                          label={`Move ${label} down`}
                          icon={<ArrowDown aria-hidden />}
                          disabled={index === rows.length - 1}
                          onClick={() => onChange(moveTrack(rows, row.key, 1))}
                        />
                        <IconButton size="xs" variant="danger" label={`Remove ${label}`} icon={<Trash2 aria-hidden />} onClick={() => onChange(removeTrack(rows, row.key))} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="flex items-center gap-2 border-t border-border bg-surface-2/40 px-3 py-2 text-xs text-fg-muted">
            <Disc3 className="size-3.5" aria-hidden />
            {pluralize(rows.length, "track")} on {pluralize(discCount, "disc")}
            {runtime !== null ? <> · {formatDuration(runtime)} total</> : null}
          </p>
        </ScrollRegion>
      )}
      {errors.length > 0 || serverError ? (
        <ul role="alert" className="space-y-0.5 text-xs font-medium text-danger">
          {[...new Set([...(serverError ? [serverError] : []), ...errors])].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
