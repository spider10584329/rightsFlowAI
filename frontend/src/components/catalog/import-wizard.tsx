"use client";

import { Download, FileSpreadsheet, FileText, FlaskConical, History, Mic2, Play, RotateCcw, Upload, UsersRound } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";

import { ImportJobView, ImportStatusBadge, normalizeImportResult } from "@/components/catalog/import-result";
import { codeLabel } from "@/components/catalog/labels";
import { ReadOnlyNotice } from "@/components/catalog/form-shell";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { downloadImportTemplate, isImportFinished, useImportJob, useImportJobs, useStartImport, type ImportEntityType, type ImportJob } from "@/lib/api/hooks/catalog";
import { cn, formatDateTime } from "@/lib/utils";

const TYPES: { value: ImportEntityType; label: string; description: string; icon: typeof FileText }[] = [
  { value: "work", label: "Works", description: "Titles, ISWCs, writers and publishers. Writers are matched or created as parties.", icon: FileText },
  { value: "recording", label: "Recordings", description: "Titles, ISRCs, artists, durations and linked work ISWCs.", icon: Mic2 },
  { value: "party", label: "Artists & contributors", description: "Names, roles, IPI/ISNI numbers and society affiliations.", icon: UsersRound },
];

const ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isAcceptedFile(file: File): boolean {
  return /\.(csv|xlsx)$/i.test(file.name);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportWizardClient() {
  const { org, can } = useOrg();
  const searchParams = useSearchParams();
  const initialType = searchParams.get("entity_type");
  const [entityType, setEntityType] = useState<ImportEntityType>(TYPES.some((type) => type.value === initialType) ? (initialType as ImportEntityType) : "work");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [deduplicated, setDeduplicated] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const start = useStartImport(org.id);
  const job = useImportJob(org.id, jobId);

  if (!can("manager")) {
    return (
      <>
        <PageHeader title="Import catalog" breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: "Import" }]} />
        <ReadOnlyNotice />
        <div className="mt-6">
          <ImportHistory orgId={org.id} />
        </div>
      </>
    );
  }

  const pickFile = (next: File | null) => {
    setFileError(null);
    if (next && !isAcceptedFile(next)) {
      setFile(null);
      setFileError("Upload a .csv or .xlsx file.");
      return;
    }
    setFile(next);
  };

  const submit = (asDryRun: boolean) => {
    if (!file) {
      setFileError("Choose a file to import.");
      return;
    }
    start.mutate(
      { file, entityType, dryRun: asDryRun },
      {
        onSuccess: (created) => {
          setJobId(created.id);
          setDeduplicated(created.deduplicated);
          toast.success(asDryRun ? "Dry run started" : "Import started");
        },
        onError: (error) => {
          if (isApiError(error) && error.code === "plan_limit_exceeded") setFileError(`${error.message} Upgrade your plan in billing settings.`);
          else setFileError(errorMessage(error));
        },
      },
    );
  };

  const reset = () => {
    setJobId(null);
    setFile(null);
    setDeduplicated(false);
    setFileError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const current = job.data;
  const result = normalizeImportResult(current?.result);
  const canRunForReal = current && current.dry_run && current.status === "succeeded" && file !== null;

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0] ?? null);
  };

  return (
    <>
      <PageHeader
        title="Import catalog"
        description="Bulk-load works, recordings or parties from a spreadsheet. Existing items are matched by identifier or internal code and updated."
        breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: "Import" }]}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {jobId ? (
            <Card>
              <CardHeader
                title={current?.dry_run ? "Dry run results" : "Import results"}
                actions={
                  <Button variant="outline" size="sm" leftIcon={<RotateCcw aria-hidden />} onClick={reset}>
                    New import
                  </Button>
                }
              />
              <CardBody className="space-y-4">
                {deduplicated ? (
                  <Alert tone="info" title="This file was uploaded before">
                    Showing the existing {current?.dry_run ? "dry run" : "import"} for the identical file instead of importing it twice.
                  </Alert>
                ) : null}
                {job.isLoading ? <PageSkeleton rows={3} /> : job.error ? <ErrorState error={job.error} compact onRetry={() => void job.refetch()} /> : current ? <ImportJobView job={current} /> : null}
                {canRunForReal ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[13px] text-fg-muted">
                      {result && result.error_count > 0
                        ? `Rows with errors will be skipped. ${result.created + result.updated} row(s) will be saved.`
                        : "The dry run looks good. Run it for real to save these changes."}
                    </p>
                    <Button leftIcon={<Play aria-hidden />} loading={start.isPending} onClick={() => submit(false)}>
                      Run import now
                    </Button>
                  </div>
                ) : null}
                {current && !current.dry_run && current.status === "succeeded" ? (
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink href={`/catalog/${current.entity_type === "party" ? "parties" : `${current.entity_type}s`}?sort=updated_at&order=desc`} variant="outline" size="sm">
                      View imported {current.entity_type === "party" ? "parties" : `${current.entity_type}s`}
                    </ButtonLink>
                    <ButtonLink href="/catalog" variant="ghost" size="sm">
                      Check validation issues
                    </ButtonLink>
                  </div>
                ) : null}
                {fileError ? <Alert tone="danger">{fileError}</Alert> : null}
              </CardBody>
            </Card>
          ) : (
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                submit(dryRun);
              }}
            >
              <Card>
                <CardHeader title="1. What are you importing?" />
                <CardBody>
                  <div role="radiogroup" aria-label="Entity type" className="grid gap-3 md:grid-cols-3">
                    {TYPES.map((type) => {
                      const Icon = type.icon;
                      const selected = entityType === type.value;
                      return (
                        <button
                          key={type.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setEntityType(type.value)}
                          className={cn(
                            "flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                            selected ? "border-primary bg-primary-soft/50 ring-1 ring-primary" : "border-border hover:bg-surface-2",
                          )}
                        >
                          <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                            <Icon className="size-4 text-primary" aria-hidden /> {type.label}
                          </span>
                          <span className="text-xs leading-relaxed text-fg-muted">{type.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2/60 px-4 py-3 text-[13px]">
                    <FileSpreadsheet className="size-4 text-fg-subtle" aria-hidden />
                    <span className="text-fg-muted">Start from the template so the column headers match.</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      leftIcon={<Download aria-hidden />}
                      loading={downloading}
                      onClick={async () => {
                        setDownloading(true);
                        try {
                          await downloadImportTemplate(org.id, entityType);
                        } catch (error) {
                          toast.error("Template download failed", { description: errorMessage(error) });
                        } finally {
                          setDownloading(false);
                        }
                      }}
                    >
                      {codeLabel(entityType)} template (CSV)
                    </Button>
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="2. Upload your file" description="CSV (UTF-8) or Excel .xlsx. The first row must contain column headers." />
                <CardBody className="space-y-4">
                  <label
                    htmlFor="import-file"
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    className={cn(
                      "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:outline-2 focus-within:outline-ring",
                      dragging ? "border-primary bg-primary-soft/40" : fileError ? "border-danger/60" : "border-border-strong hover:bg-surface-2/60",
                    )}
                  >
                    <Upload className="size-6 text-fg-subtle" aria-hidden />
                    {file ? (
                      <>
                        <span className="text-sm font-medium text-fg">{file.name}</span>
                        <span className="text-xs text-fg-subtle">{formatBytes(file.size)} · click to choose another file</span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-fg">Drop a file here or click to browse</span>
                        <span className="text-xs text-fg-subtle">.csv or .xlsx</span>
                      </>
                    )}
                    <input
                      ref={inputRef}
                      id="import-file"
                      type="file"
                      accept={ACCEPT}
                      className="sr-only"
                      aria-invalid={fileError ? true : undefined}
                      aria-describedby={fileError ? "import-file-error" : undefined}
                      onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {fileError ? (
                    <p id="import-file-error" role="alert" className="text-xs font-medium text-danger">
                      {fileError}
                    </p>
                  ) : null}
                  <div className="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
                    <Switch id="import-dry-run" checked={dryRun} onCheckedChange={setDryRun} className="mt-0.5" />
                    <div>
                      <Label htmlFor="import-dry-run" className="flex items-center gap-1.5">
                        <FlaskConical className="size-3.5 text-fg-subtle" aria-hidden /> Dry run first
                      </Label>
                      <p className="text-xs text-fg-muted">Validate every row and preview the changes without saving anything. Recommended.</p>
                    </div>
                  </div>
                </CardBody>
              </Card>

              <div className="flex justify-end gap-2">
                <ButtonLink href="/catalog" variant="outline">
                  Cancel
                </ButtonLink>
                <Button type="submit" leftIcon={dryRun ? <FlaskConical aria-hidden /> : <Upload aria-hidden />} loading={start.isPending} disabled={!file}>
                  {dryRun ? "Start dry run" : "Import now"}
                </Button>
              </div>
            </form>
          )}
        </div>
        <aside>
          <ImportHistory orgId={org.id} highlight={jobId} compact />
        </aside>
      </div>
    </>
  );
}

function resultSummary(job: ImportJob): string {
  const result = normalizeImportResult(job.result);
  if (!result) return job.error ? "Failed" : "—";
  return `${result.created} new · ${result.updated} updated${result.error_count ? ` · ${result.error_count} errors` : ""}`;
}

export function ImportHistory({ orgId, highlight, compact }: { orgId: string; highlight?: string | null; compact?: boolean }) {
  const jobs = useImportJobs(orgId, 25);
  const router = useRouter();

  const columns: DataTableColumn<ImportJob>[] = compact
    ? [
        {
          id: "file",
          header: "File",
          cell: (job) => (
            <div className="min-w-0 max-w-[12rem]">
              <Link href={`/catalog/imports/${job.id}`} className="block truncate font-medium text-fg hover:text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
                {job.filename ?? "Upload"}
              </Link>
              <p className="truncate text-xs text-fg-subtle">
                {codeLabel(job.entity_type ?? "")}
                {job.dry_run ? " · dry run" : ""} · {formatDateTime(job.created_at)}
              </p>
            </div>
          ),
        },
        { id: "status", header: "Status", cell: (job) => <ImportStatusBadge status={job.status} /> },
      ]
    : [
        {
          id: "file",
          header: "File",
          cell: (job) => (
            <Link href={`/catalog/imports/${job.id}`} className="font-medium text-fg hover:text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
              {job.filename ?? "Upload"}
            </Link>
          ),
        },
        { id: "type", header: "Type", cell: (job) => codeLabel(job.entity_type ?? "") },
        { id: "mode", header: "Mode", cell: (job) => (job.dry_run ? <Badge tone="accent">Dry run</Badge> : <Badge>Import</Badge>) },
        { id: "status", header: "Status", cell: (job) => <ImportStatusBadge status={job.status} /> },
        { id: "result", header: "Result", hideOnMobile: true, cell: (job) => <span className="text-[13px] text-fg-muted">{resultSummary(job)}</span> },
        { id: "date", header: "Started", hideOnMobile: true, cell: (job) => <span className="whitespace-nowrap text-[13px] text-fg-muted">{formatDateTime(job.created_at)}</span> },
      ];

  return (
    <Card>
      <CardHeader title="Import history" description={compact ? undefined : "The 25 most recent imports in this organization."} />
      <DataTable
        columns={columns}
        data={jobs.data}
        getRowId={(job) => job.id}
        getRowLabel={(job) => job.filename ?? job.id}
        isLoading={jobs.isLoading}
        error={jobs.error}
        onRetry={() => void jobs.refetch()}
        onRowClick={(job) => router.push(`/catalog/imports/${job.id}`)}
        rowClassName={(job) => (job.id === highlight ? "bg-primary-soft/40" : undefined)}
        caption="Import history"
        skeletonRows={3}
        emptyState={<EmptyState compact icon={<History aria-hidden />} title="No imports yet" description="Your uploads and dry runs will be listed here." />}
      />
    </Card>
  );
}

/** `/catalog/imports/[id]` — the target of import notifications. */
export function ImportJobClient() {
  const { org } = useOrg();
  const id = useParams<{ id: string }>().id;
  const job = useImportJob(org.id, id);
  const finished = isImportFinished(job.data?.status);
  return (
    <>
      <PageHeader
        title={job.data?.filename ?? "Import"}
        description={job.data ? `${codeLabel(job.data.entity_type ?? "")} import${job.data.dry_run ? " (dry run)" : ""}` : undefined}
        breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: "Import", href: "/catalog/import" }, { label: "Job" }]}
        actions={
          <ButtonLink href={job.data?.entity_type ? `/catalog/import?entity_type=${job.data.entity_type}` : "/catalog/import"} variant="outline" leftIcon={<Upload aria-hidden />}>
            {finished ? "New import" : "Import another file"}
          </ButtonLink>
        }
      />
      <Card>
        <CardBody>
          {job.isLoading ? (
            <PageSkeleton rows={3} />
          ) : job.error ? (
            <ErrorState error={job.error} title={isApiError(job.error) && job.error.isNotFound ? "Import not found" : undefined} onRetry={() => void job.refetch()} />
          ) : job.data ? (
            <ImportJobView job={job.data} />
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}
