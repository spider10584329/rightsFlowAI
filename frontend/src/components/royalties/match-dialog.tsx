"use client";

import { Disc3, FileText, Link2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useBulkMatch, useMatchLine, useRecordingSearch, useWorkSearch, type BulkMatchInput } from "@/lib/api/hooks/royalties";
import { cn } from "@/lib/utils";

export interface MatchKeyLine {
  id: string;
  isrc: string | null;
  title: string | null;
  artist: string | null;
}

export interface MatchTarget {
  statementId: string;
  /** A representative line: enables "this line" and "all lines with the same ISRC/title" scopes. */
  keyLine?: MatchKeyLine;
  /** Explicit selection (bulk). */
  lineIds?: string[];
  /** Restrict scopes to bulk keys (used for grouped unmatched rows). */
  groupOnly?: boolean;
  label: string;
}

type Scope = "line" | "isrc" | "title_artist" | "title" | "selection";

function defaultScope(target: MatchTarget): Scope {
  if (target.lineIds && target.lineIds.length > 0) return "selection";
  if (target.groupOnly) return target.keyLine?.isrc ? "isrc" : target.keyLine?.artist ? "title_artist" : "title";
  return "line";
}

export function MatchDialog({ orgId, target, onClose }: { orgId: string; target: MatchTarget | null; onClose: () => void }) {
  return target ? <MatchDialogInner key={`${target.statementId}-${target.keyLine?.id ?? ""}-${target.lineIds?.join(",") ?? ""}`} orgId={orgId} target={target} onClose={onClose} /> : null;
}

function MatchDialogInner({ orgId, target, onClose }: { orgId: string; target: MatchTarget; onClose: () => void }) {
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const [scope, setScope] = useState<Scope>(defaultScope(target));
  const [error, setError] = useState<string | null>(null);
  const matchLine = useMatchLine(orgId, target.statementId);
  const bulk = useBulkMatch(orgId, target.statementId);
  const pending = matchLine.isPending || bulk.isPending;

  const scopes: { value: Scope; label: string }[] = [];
  if (target.lineIds && target.lineIds.length > 0) scopes.push({ value: "selection", label: `${target.lineIds.length} selected line${target.lineIds.length === 1 ? "" : "s"}` });
  if (target.keyLine && !target.groupOnly) scopes.push({ value: "line", label: "This line only" });
  if (target.keyLine?.isrc) scopes.push({ value: "isrc", label: `All unmatched lines with ISRC ${target.keyLine.isrc}` });
  if (target.keyLine?.title && target.keyLine.artist) scopes.push({ value: "title_artist", label: `All unmatched lines titled “${target.keyLine.title}” by ${target.keyLine.artist}` });
  if (target.keyLine?.title) scopes.push({ value: "title", label: `All unmatched lines titled “${target.keyLine.title}”` });

  const submit = async () => {
    if (!selected) return;
    setError(null);
    const ids = selected.kind === "recording" ? { recording_id: selected.id, work_id: null } : { work_id: selected.id, recording_id: null };
    try {
      if (scope === "line" && target.keyLine) {
        await matchLine.mutateAsync({ lineId: target.keyLine.id, action: "match", ...ids });
        toast.success("Line matched", { description: `Matched to ${selected.title}. Recalculate to include it.` });
      } else {
        const body: BulkMatchInput =
          scope === "selection" ? { action: "match", line_ids: target.lineIds, ...ids } : { action: "match", match_key: scope as BulkMatchInput["match_key"], key_line_id: target.keyLine?.id, ...ids };
        const result = await bulk.mutateAsync(body);
        toast.success(`${result.updated} line${result.updated === 1 ? "" : "s"} matched`, { description: `Matched to ${selected.title}.` });
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      size="lg"
      title="Match to catalog"
      description={target.label}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={pending} disabled={!selected} leftIcon={<Link2 aria-hidden />}>
            Match
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <CatalogSearch orgId={orgId} initialQuery={target.keyLine?.isrc ?? target.keyLine?.title ?? ""} keyIsrc={target.keyLine?.isrc ?? null} value={selected} onChange={setSelected} />
        {scopes.length > 1 ? (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-medium text-fg">Apply to</legend>
            {scopes.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
                <input type="radio" name="match-scope" className="mt-0.5 accent-[var(--primary)]" checked={scope === option.value} onChange={() => setScope(option.value)} />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-fg-subtle">Changing matches discards any unposted calculation for this statement; recalculate afterwards.</p>
      </div>
    </Dialog>
  );
}

export interface CatalogSelection {
  kind: "recording" | "work";
  id: string;
  title: string;
  /** ISRC or ISWC of the selected item, when known. */
  code: string | null;
}

/** Recording / work search with a single-select result list (shared by matching and manual statements). */
export function CatalogSearch({
  orgId,
  initialQuery = "",
  keyIsrc = null,
  value,
  onChange,
}: {
  orgId: string;
  initialQuery?: string;
  keyIsrc?: string | null;
  value: CatalogSelection | null;
  onChange: (value: CatalogSelection | null) => void;
}) {
  const [kind, setKind] = useState<"recording" | "work">(value?.kind ?? "recording");
  const [query, setQuery] = useState(initialQuery);
  const recordings = useRecordingSearch(orgId, query, kind === "recording");
  const works = useWorkSearch(orgId, query, kind === "work");
  const results =
    kind === "recording"
      ? (recordings.data?.items ?? []).map((r) => ({
          id: r.id,
          title: r.version_title ? `${r.title} (${r.version_title})` : r.title,
          meta: [r.display_artist ?? r.primary_artist_name ?? r.artist, r.isrc].filter(Boolean).join(" · "),
          code: r.isrc ?? null,
        }))
      : (works.data?.items ?? []).map((w) => ({ id: w.id, title: w.title, meta: [w.iswc].filter(Boolean).join(" · "), code: w.iswc ?? null }));
  const loading = kind === "recording" ? recordings.isLoading : works.isLoading;
  const searchError = kind === "recording" ? recordings.error : works.error;

  return (
    <div className="space-y-4">
      <SegmentedControl
        aria-label="Match to"
        value={kind}
        onValueChange={(next) => {
          setKind(next);
          onChange(null);
        }}
        options={[
          {
            value: "recording",
            label: (
              <>
                <Disc3 aria-hidden /> Recording
              </>
            ),
          },
          {
            value: "work",
            label: (
              <>
                <FileText aria-hidden /> Work
              </>
            ),
          },
        ]}
      />
      <SearchInput
        value={query}
        onChange={setQuery}
        className="sm:w-full"
        placeholder={kind === "recording" ? "Search recordings by title, artist or ISRC" : "Search works by title or ISWC"}
        aria-label={`Search ${kind}s`}
      />
      <div role="radiogroup" aria-label={`Matching ${kind}s`} className="max-h-64 space-y-1.5 overflow-y-auto">
        {loading ? (
          Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)
        ) : searchError ? (
          <p className="text-[13px] text-danger">{errorMessage(searchError)}</p>
        ) : results.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[13px] text-fg-muted">
            No {kind}s found. Try another search, or add the {kind} in the catalog first.
          </p>
        ) : (
          results.map((item) => {
            const active = value?.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ kind, id: item.id, title: item.title, code: item.code })}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  active ? "border-primary bg-primary-soft/50" : "border-border hover:bg-surface-2",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-fg">{item.title}</span>
                  {item.meta ? <span className="block truncate text-xs text-fg-subtle">{item.meta}</span> : null}
                </span>
                {item.code && keyIsrc && item.code === keyIsrc ? <Badge tone="success">ISRC match</Badge> : active ? <Badge tone="primary">Selected</Badge> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
