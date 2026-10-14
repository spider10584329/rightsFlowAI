"use client";

import { CheckCircle2, CircleSlash, Clock, FlaskConical, Loader2, XCircle } from "lucide-react";

import { codeLabel } from "@/components/catalog/labels";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { ImportJob, ImportResult } from "@/lib/api/hooks/catalog";
import { cn, formatDateTime, pluralize } from "@/lib/utils";

export const IMPORT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function ImportStatusBadge({ status }: { status: string }) {
  const meta = IMPORT_STATUS_META[status] ?? { label: codeLabel(status), tone: "neutral" as const };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

/** Fills in defaults for a (possibly partial) job result. */
export function normalizeImportResult(result: Partial<ImportResult> | null | undefined): ImportResult | null {
  if (!result) return null;
  return {
    entity_type: result.entity_type ?? "work",
    dry_run: Boolean(result.dry_run),
    filename: result.filename ?? "",
    total_rows: result.total_rows ?? 0,
    created: result.created ?? 0,
    updated: result.updated ?? 0,
    skipped: result.skipped ?? 0,
    parties_created: result.parties_created ?? 0,
    error_count: result.error_count ?? result.errors?.length ?? 0,
    errors: result.errors ?? [],
    errors_truncated: Boolean(result.errors_truncated),
    ignored_columns: result.ignored_columns ?? [],
  };
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "info" | "neutral" | "danger" }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "success" && value > 0 && "text-success-soft-fg",
          tone === "danger" && value > 0 && "text-danger",
          (!tone || tone === "neutral" || value === 0) && "text-fg",
          tone === "info" && value > 0 && "text-info-soft-fg",
        )}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

/** Status, progress and per-row results of a catalog import job. */
export function ImportJobView({ job }: { job: ImportJob }) {
  const result = normalizeImportResult(job.result);
  const finished = job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
  const entityPlural = job.entity_type === "party" ? "parties" : `${job.entity_type ?? "item"}s`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
        <ImportStatusBadge status={job.status} />
        {job.dry_run ? (
          <Badge tone="accent">
            <FlaskConical className="size-3" aria-hidden /> Dry run
          </Badge>
        ) : null}
        <span>
          {job.filename ?? "Uploaded file"} · {codeLabel(job.entity_type ?? "")} import · started {formatDateTime(job.created_at)}
        </span>
        {job.finished_at ? <span>· finished {formatDateTime(job.finished_at)}</span> : null}
      </div>

      {!finished ? (
        <div className="space-y-2" aria-live="polite">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 font-medium text-fg">
              {job.status === "queued" ? <Clock className="size-4 text-fg-subtle" aria-hidden /> : <Loader2 className="size-4 animate-spin text-primary" aria-hidden />}
              {job.status === "queued" ? "Waiting for a worker…" : "Importing rows…"}
            </span>
            <span className="tabular-nums text-fg-muted">{job.progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} aria-label="Import progress">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(3, job.progress)}%` }} />
          </div>
        </div>
      ) : null}

      {job.status === "failed" ? (
        <Alert tone="danger" title="Import failed">
          {job.error ?? "The file could not be processed."} Fix the file and upload it again.
        </Alert>
      ) : null}
      {job.status === "cancelled" ? (
        <Alert tone="warning" title="Import cancelled">
          No further rows were processed.
        </Alert>
      ) : null}

      {result ? (
        <>
          {result.dry_run ? (
            <Alert tone="info" title="Dry run — nothing was saved">
              These are the changes a real import would make. Fix any row errors, then run the import for real.
            </Alert>
          ) : job.status === "succeeded" ? (
            <Alert tone={result.error_count > 0 ? "warning" : "success"} title={result.error_count > 0 ? "Imported with row errors" : "Import complete"}>
              {result.created + result.updated > 0 ? `${pluralize(result.created + result.updated, "row")} saved to your catalog.` : "No rows were saved."}
              {result.error_count > 0 ? ` ${pluralize(result.error_count, "row")} failed and were skipped.` : ""}
            </Alert>
          ) : null}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Rows read" value={result.total_rows} />
            <Metric label={result.dry_run ? "Would create" : "Created"} value={result.created} tone="success" />
            <Metric label={result.dry_run ? "Would update" : "Updated"} value={result.updated} tone="info" />
            <Metric label="Unchanged / skipped" value={result.skipped} tone="neutral" />
            <Metric label={result.dry_run ? "Parties to create" : "Parties created"} value={result.parties_created} tone="info" />
            <Metric label="Row errors" value={result.error_count} tone="danger" />
          </dl>
          {result.ignored_columns.length > 0 ? (
            <p className="text-xs text-fg-muted">
              <span className="font-medium text-fg">Ignored columns:</span> {result.ignored_columns.join(", ")} — they don&apos;t match any {job.entity_type} field.
            </p>
          ) : null}
          {result.errors.length > 0 ? (
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                <XCircle className="size-4 text-danger" aria-hidden /> Row errors
              </h3>
              <div className="max-h-96 overflow-auto rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <caption className="sr-only">Rows that could not be imported</caption>
                  <thead className="sticky top-0 bg-surface-2 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                    <tr>
                      <th scope="col" className="w-20 px-3 py-2 font-semibold">
                        Row
                      </th>
                      <th scope="col" className="px-3 py-2 font-semibold">
                        Problem
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {result.errors.map((error, index) => (
                      <tr key={`${error.row}-${index}`}>
                        <td className="px-3 py-2 font-mono tabular-nums text-fg-muted">{error.row}</td>
                        <td className="px-3 py-2 text-fg">{error.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.errors_truncated ? (
                <p className="text-xs text-fg-subtle">
                  Showing the first {result.errors.length} of {result.error_count} errors.
                </p>
              ) : null}
            </div>
          ) : finished && job.status === "succeeded" ? (
            <p className="flex items-center gap-1.5 text-[13px] text-success-soft-fg">
              <CheckCircle2 className="size-4 text-success" aria-hidden /> Every row was valid.
            </p>
          ) : null}
        </>
      ) : finished && job.status === "succeeded" ? (
        <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
          <CircleSlash className="size-4" aria-hidden /> No result was recorded for this job ({entityPlural}).
        </p>
      ) : null}
    </div>
  );
}
