"use client";

import { Ban, Eye, ListTodo, RotateCw } from "lucide-react";
import { useState } from "react";

import { JOB_TYPE_LABELS, JobDrawer, JobProgress, JobStatusBadge, jobTypeLabel } from "@/components/jobs/job-ui";
import { useOrg } from "@/components/session/org-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { isJobActive, JOB_POLL_MS, JOB_STATUSES, useCancelJob, useJobs, useRetryJob, type Job, type JobStatus } from "@/lib/api/hooks/jobs";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

export function JobsClient() {
  const { org, can } = useOrg();
  const canManage = can("manager");
  const table = useTableQueryState<"status" | "job_type">({
    defaultPageSize: 25,
    defaultSort: { key: "created_at", order: "desc" },
    filterKeys: ["status", "job_type"],
  });
  const status = (JOB_STATUSES as string[]).includes(table.filters.status) ? (table.filters.status as JobStatus) : undefined;
  const jobs = useJobs(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    status,
    job_type: table.filters.job_type || undefined,
  });
  const cancel = useCancelJob(org.id);
  const retry = useRetryJob(org.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Job | null>(null);

  const polling = Boolean(jobs.data?.items.some(isJobActive));

  const doRetry = (job: Job) =>
    retry.mutate(job.id, {
      onSuccess: () => toast.success(`${jobTypeLabel(job.job_type)} re-queued`),
      onError: (error) => toast.error("Couldn't retry job", { description: errorMessage(error) }),
    });

  const columns: DataTableColumn<Job>[] = [
    {
      id: "job_type",
      header: "Job",
      sortKey: "job_type",
      cell: (job) => (
        <div className="min-w-0">
          <button type="button" onClick={() => setOpenId(job.id)} className="font-medium text-fg hover:text-primary hover:underline">
            {jobTypeLabel(job.job_type)}
          </button>
          <p className="truncate font-mono text-2xs text-fg-subtle">{job.id.slice(0, 8)}</p>
        </div>
      ),
    },
    { id: "status", header: "Status", sortKey: "status", cell: (job) => <JobStatusBadge status={job.status} /> },
    { id: "progress", header: "Progress", cell: (job) => <JobProgress job={job} label={jobTypeLabel(job.job_type)} /> },
    { id: "attempts", header: "Attempts", align: "right", hideOnMobile: true, cell: (job) => <span className="tabular-nums">{job.attempts} / {job.max_attempts}</span> },
    {
      id: "error",
      header: "Error",
      hideOnMobile: true,
      cell: (job) => (job.error ? <span className="line-clamp-2 max-w-xs text-xs text-danger" title={job.error}>{job.error}</span> : <span className="text-fg-subtle">—</span>),
    },
    {
      id: "created_at",
      header: "Created",
      sortKey: "created_at",
      cell: (job) => (
        <time dateTime={job.created_at} title={formatDateTime(job.created_at)} className="whitespace-nowrap text-fg-muted">
          {formatRelative(job.created_at)}
        </time>
      ),
    },
    { id: "finished", header: "Finished", hideOnMobile: true, cell: (job) => <span className="whitespace-nowrap text-fg-muted">{formatDateTime(job.finished_at)}</span> },
  ];

  const rowActions = (job: Job): RowAction[] => {
    const actions: RowAction[] = [{ label: "View details", icon: <Eye aria-hidden />, onSelect: () => setOpenId(job.id) }];
    if (canManage && job.status === "queued") actions.push({ label: "Cancel job", icon: <Ban aria-hidden />, destructive: true, separated: true, onSelect: () => setCancelling(job) });
    if (canManage && (job.status === "failed" || job.status === "cancelled")) actions.push({ label: "Retry job", icon: <RotateCw aria-hidden />, separated: true, onSelect: () => doRetry(job) });
    return actions;
  };

  const knownTypes = Object.keys(JOB_TYPE_LABELS);
  const typeOptions = [
    { value: "all", label: "All job types" },
    ...knownTypes.map((type) => ({ value: type, label: JOB_TYPE_LABELS[type] })),
    ...(table.filters.job_type && !knownTypes.includes(table.filters.job_type) ? [{ value: table.filters.job_type, label: titleCase(table.filters.job_type) }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Background jobs"
        description="Imports, contract analysis, reports and scheduled checks running for this organization."
        breadcrumbs={[{ label: "Admin" }, { label: "Background jobs" }]}
        meta={
          polling ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle" role="status">
              <span className="size-1.5 animate-pulse rounded-full bg-info" aria-hidden /> Auto-refreshing every {JOB_POLL_MS / 1000}s
            </span>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" leftIcon={<RotateCw aria-hidden />} onClick={() => void jobs.refetch()} loading={jobs.isFetching && !jobs.isLoading}>
            Refresh
          </Button>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <Select
            size="sm"
            className="sm:w-44"
            aria-label="Filter by status"
            value={status ?? "all"}
            onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}
            options={[{ value: "all", label: "All statuses" }, ...JOB_STATUSES.map((value) => ({ value, label: titleCase(value) }))]}
          />
          <Select
            size="sm"
            className="sm:w-56"
            aria-label="Filter by job type"
            value={table.filters.job_type || "all"}
            onValueChange={(value) => table.setFilter("job_type", value === "all" ? null : value)}
            options={typeOptions}
          />
          {status || table.filters.job_type ? (
            <Button variant="ghost" size="sm" onClick={table.reset} className="sm:ml-auto">
              Clear filters
            </Button>
          ) : null}
        </div>
        <DataTable
          columns={columns}
          data={jobs.data?.items}
          getRowId={(job) => job.id}
          getRowLabel={(job) => `${jobTypeLabel(job.job_type)} ${job.id.slice(0, 8)}`}
          isLoading={jobs.isLoading}
          isFetching={jobs.isFetching && !polling}
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
          sort={table.sort}
          onSortChange={table.setSort}
          rowActions={rowActions}
          caption="Background jobs"
          emptyState={
            <EmptyState
              compact
              icon={<ListTodo aria-hidden />}
              title={status || table.filters.job_type ? "No jobs match these filters" : "No background jobs yet"}
              description="Jobs are created when you import a catalog or statement, analyse a contract or generate a report."
            />
          }
        />
        {jobs.data && jobs.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={jobs.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>

      <JobDrawer
        orgId={org.id}
        jobId={openId}
        onClose={() => setOpenId(null)}
        canManage={canManage}
        onCancel={(job) => setCancelling(job)}
        onRetry={doRetry}
        busy={retry.isPending || cancel.isPending}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel job?"
        description={cancelling ? `The queued ${jobTypeLabel(cancelling.job_type).toLowerCase()} job won't run. You can retry it later.` : undefined}
        confirmLabel="Cancel job"
        cancelLabel="Keep job"
        onConfirm={async () => {
          if (!cancelling) return;
          await cancel.mutateAsync(cancelling.id);
          toast.success("Job cancelled");
        }}
      />
    </>
  );
}
