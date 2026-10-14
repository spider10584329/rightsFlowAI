"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Ban, RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { KeyValueList } from "@/components/ui/key-value";
import { Skeleton } from "@/components/ui/skeleton";
import { isJobActive, useJob, type Job } from "@/lib/api/hooks/jobs";
import { useRestoreFocus } from "@/lib/hooks/use-restore-focus";
import { cn, formatDateTime, titleCase } from "@/lib/utils";

export const JOB_TYPE_LABELS: Record<string, string> = {
  catalog_import: "Catalog import",
  royalty_import: "Statement import",
  contract_analysis: "Contract analysis",
  contract_expiry_check: "Contract expiry check",
  report_generation: "Report generation",
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? titleCase(type);
}

const STATUS_TONE: Record<string, BadgeTone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "warning",
};

export function JobStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

/** Clamp to 0..100 (the backend stores an int; be defensive). */
export function clampProgress(progress: number | null | undefined): number {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

export function JobProgress({ job, label }: { job: Pick<Job, "progress" | "status">; label: string }) {
  const value = job.status === "succeeded" ? 100 : clampProgress(job.progress);
  return (
    <div className="flex min-w-28 items-center gap-2">
      <div
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            job.status === "failed" ? "bg-danger" : job.status === "cancelled" ? "bg-warning" : job.status === "succeeded" ? "bg-success" : "bg-primary",
            job.status === "running" && "animate-pulse",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-fg-muted">{value}%</span>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg border border-border bg-surface-2/60 p-3 font-mono text-xs leading-relaxed text-fg">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

export function JobDrawer({
  orgId,
  jobId,
  onClose,
  canManage,
  onCancel,
  onRetry,
  busy,
}: {
  orgId: string;
  jobId: string | null;
  onClose: () => void;
  canManage: boolean;
  onCancel: (job: Job) => void;
  onRetry: (job: Job) => void;
  busy: boolean;
}) {
  const job = useJob(orgId, jobId);
  const data = job.data;
  const restoreFocus = useRestoreFocus();

  return (
    <DialogPrimitive.Root open={jobId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-surface text-fg shadow-lg outline-none" {...restoreFocus}>
          <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
            <div className="min-w-0 space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold tracking-tight">{data ? jobTypeLabel(data.job_type) : "Job details"}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="font-mono text-xs text-fg-subtle">{jobId}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="inline-flex size-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring" aria-label="Close">
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-6 py-5">
            {job.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : job.error || !data ? (
              <ErrorState error={job.error} onRetry={() => void job.refetch()} compact />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <JobStatusBadge status={data.status} />
                  <div className="min-w-48 flex-1">
                    <JobProgress job={data} label={jobTypeLabel(data.job_type)} />
                  </div>
                  {isJobActive(data) ? <span className="text-xs text-fg-subtle">Refreshing automatically</span> : null}
                </div>
                <KeyValueList
                  items={[
                    { label: "Attempts", value: `${data.attempts} of ${data.max_attempts}` },
                    { label: "Created", value: formatDateTime(data.created_at) },
                    { label: "Run after", value: formatDateTime(data.run_after) },
                    { label: "Started", value: formatDateTime(data.started_at) },
                    { label: "Finished", value: formatDateTime(data.finished_at) },
                    { label: "Last update", value: formatDateTime(data.updated_at) },
                  ]}
                />
                {data.error ? (
                  <Section title="Error">
                    <p role="alert" className="whitespace-pre-wrap break-words rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
                      {data.error}
                    </p>
                  </Section>
                ) : null}
                <Section title="Result">{data.result ? <Json value={data.result} /> : <p className="text-[13px] text-fg-muted">No result yet.</p>}</Section>
                <Section title="Payload">{data.payload ? <Json value={data.payload} /> : <p className="text-[13px] text-fg-muted">No payload.</p>}</Section>
              </>
            )}
          </div>
          {data && canManage && (data.status === "queued" || data.status === "failed" || data.status === "cancelled") ? (
            <div className="flex justify-end gap-2 border-t border-border bg-surface-2/60 px-6 py-3">
              {data.status === "queued" ? (
                <Button variant="danger" leftIcon={<Ban aria-hidden />} onClick={() => onCancel(data)} loading={busy}>
                  Cancel job
                </Button>
              ) : (
                <Button leftIcon={<RotateCw aria-hidden />} onClick={() => onRetry(data)} loading={busy}>
                  Retry job
                </Button>
              )}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
