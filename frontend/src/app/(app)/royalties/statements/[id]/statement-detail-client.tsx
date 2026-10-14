"use client";

import { AlertTriangle, Ban, Calculator, Download, FileSearch, LayoutDashboard, ListChecks, Pencil, RefreshCw, RotateCcw, SlidersHorizontal, Trash2, Unlink } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { STATEMENT_IN_PROGRESS, STATEMENT_REPROCESSABLE, sourceCategoryLabel } from "@/components/royalties/labels";
import { ProgressBar, StatementStatusBadge, formatPeriod } from "@/components/royalties/shared";
import { useUrlParam } from "@/components/royalties/use-url-param";
import { useOrg } from "@/components/session/org-provider";
import { DetailLoadError } from "@/components/shared/detail-load-error";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatementEditDialog } from "@/components/royalties/statement-edit-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import {
  downloadStatementFile,
  useCancelStatementProcessing,
  useDeleteStatement,
  useJob,
  useProcessStatement,
  useRematchStatement,
  useStatement,
} from "@/lib/api/hooks/royalties";

import { AnomaliesTab } from "./anomalies-tab";
import { CalculationTab } from "./calculation-tab";
import { LinesTab } from "./lines-tab";
import { OverviewTab } from "./overview-tab";

const TABS = ["overview", "lines", "unmatched", "anomalies", "calculation"] as const;
type Tab = (typeof TABS)[number];

export function StatementDetailClient() {
  const { id } = useParams<{ id: string }>();
  const { org, can } = useOrg();
  const router = useRouter();
  const statement = useStatement(org.id, id);
  const [tab, setTab] = useUrlParam<Tab>("tab", TABS, "overview");
  const process = useProcessStatement(org.id);
  const rematch = useRematchStatement(org.id, id);
  const remove = useDeleteStatement(org.id);
  const cancel = useCancelStatementProcessing(org.id);
  const [dialog, setDialog] = useState<"reprocess" | "delete" | "edit" | null>(null);
  const inFlight = statement.data ? STATEMENT_IN_PROGRESS.has(statement.data.status) : false;
  const job = useJob(org.id, inFlight ? (statement.data?.job_id ?? null) : null);

  if (statement.isLoading) return <PageSkeleton />;
  if (statement.error || !statement.data) {
    return (
      <DetailLoadError
        error={statement.error}
        noun="Statement"
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }]}
        backHref="/royalties/statements"
        backLabel="Back to statements"
        onRetry={() => void statement.refetch()}
      />
    );
  }

  const s = statement.data;
  const canManage = can("manager");
  const isAdmin = can("admin");
  const mutable = STATEMENT_REPROCESSABLE.has(s.status);
  const hasLines = !["uploaded", "queued", "processing"].includes(s.status) || s.valid_rows > 0;

  const doRematch = () =>
    rematch.mutate(undefined, {
      onSuccess: (result) =>
        toast.success(result.newly_matched > 0 ? `${result.newly_matched} line${result.newly_matched === 1 ? "" : "s"} newly matched` : "No new matches found", {
          description: result.newly_matched > 0 ? "Recalculate to include them." : "Add the missing recordings or works to the catalog, or match lines manually.",
        }),
      onError: (error) => toast.error("Rematch failed", { description: errorMessage(error) }),
    });

  return (
    <>
      <PageHeader
        title={s.source_name}
        meta={<StatementStatusBadge status={s.status} size="md" />}
        description={`${sourceCategoryLabel(s.source_category)} · ${formatPeriod(s.period_start, s.period_end)} · ${s.currency}${s.file_name ? ` · ${s.file_name}` : ""}`}
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: s.source_name }]}
        actions={
          <>
            {s.file_id ? (
              <Button
                variant="outline"
                leftIcon={<Download aria-hidden />}
                onClick={() => void downloadStatementFile(org.id, s.id).catch((e) => toast.error("Download failed", { description: errorMessage(e) }))}
              >
                Source file
              </Button>
            ) : null}
            {canManage && (s.status === "processed" || s.status === "calculated") ? (
              <Button leftIcon={<Calculator aria-hidden />} onClick={() => setTab("calculation")}>
                Calculate
              </Button>
            ) : null}
            {canManage && s.status === "uploaded" ? (
              <ButtonLink href={`/royalties/statements/new?statement=${s.id}`} leftIcon={<SlidersHorizontal aria-hidden />}>
                Map & process
              </ButtonLink>
            ) : null}
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">More</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem icon={<Pencil aria-hidden />} disabled={inFlight || s.status === "posted"} onSelect={() => setDialog("edit")}>
                    Edit details
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={<RefreshCw aria-hidden />} disabled={!mutable || !hasLines || rematch.isPending} onSelect={doRematch}>
                    Re-run automatic matching
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<SlidersHorizontal aria-hidden />}
                    disabled={!mutable || !s.file_id}
                    onSelect={() => router.push(`/royalties/statements/new?statement=${s.id}&step=map`)}
                  >
                    Edit column mapping
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={<RotateCcw aria-hidden />} disabled={!mutable || !s.file_id || s.status === "uploaded"} onSelect={() => setDialog("reprocess")}>
                    Reprocess file
                  </DropdownMenuItem>
                  {isAdmin ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem icon={<Trash2 aria-hidden />} destructive disabled={inFlight || s.status === "posted"} onSelect={() => setDialog("delete")}>
                        Delete statement
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {inFlight ? (
        <Alert tone="info" title={s.status === "queued" ? "Queued for processing" : "Processing…"} className="mb-6">
          <ProgressBar value={Math.max(s.status === "queued" ? 2 : 5, job.data?.progress ?? 0)} label="Validating and matching rows" />
          {s.status === "queued" && canManage ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              leftIcon={<Ban aria-hidden />}
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(s.id, {
                  onSuccess: () => toast.success("Processing cancelled"),
                  onError: (error) => toast.error("Could not cancel", { description: errorMessage(error) }),
                })
              }
            >
              Cancel processing
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {s.status === "posted" ? (
        <Alert tone="success" title="Posted to the ledger" className="mb-6">
          Royalties from this statement are posted. Its lines can no longer change; reverse the run to correct them.
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard aria-hidden /> Overview
          </TabsTrigger>
          <TabsTrigger value="lines">
            <ListChecks aria-hidden /> Lines
          </TabsTrigger>
          <TabsTrigger value="unmatched">
            <Unlink aria-hidden /> Unmatched
            {s.valid_rows > s.matched_rows && hasLines ? <span className="rounded-full bg-warning-soft px-1.5 text-2xs text-warning-soft-fg">{(s.valid_rows - s.matched_rows).toLocaleString()}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="anomalies">
            <AlertTriangle aria-hidden /> Anomalies
          </TabsTrigger>
          <TabsTrigger value="calculation">
            <Calculator aria-hidden /> Calculation
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab orgId={org.id} statement={s} />
        </TabsContent>
        <TabsContent value="lines">
          {hasLines ? <LinesTab orgId={org.id} statement={s} mode="all" canManage={canManage} /> : <NotProcessed />}
        </TabsContent>
        <TabsContent value="unmatched">
          {hasLines ? <LinesTab orgId={org.id} statement={s} mode="unmatched" canManage={canManage} /> : <NotProcessed />}
        </TabsContent>
        <TabsContent value="anomalies">{hasLines ? <AnomaliesTab orgId={org.id} statementId={s.id} /> : <NotProcessed />}</TabsContent>
        <TabsContent value="calculation">
          <CalculationTab orgId={org.id} statement={s} />
        </TabsContent>
      </Tabs>

      <StatementEditDialog orgId={org.id} statement={s} open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)} />
      <ConfirmDialog
        open={dialog === "reprocess"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Reprocess this statement?"
        description="All lines are parsed and matched again from the source file. Manual matches and any unposted calculation for this statement are replaced."
        confirmLabel="Reprocess"
        tone="primary"
        onConfirm={async () => {
          await process.mutateAsync(s.id);
          toast.success("Reprocessing started");
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Delete statement?"
        description="The statement, its lines and unposted calculations are deleted. Statements with posted or reversed royalties are part of the financial record and cannot be deleted."
        confirmLabel="Delete statement"
        confirmText="DELETE"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(s.id);
          } catch (error) {
            if (isApiError(error) && error.code === "statement_posted") {
              throw new Error("Royalties from this statement were posted to the ledger, so it is part of the financial record and cannot be deleted.");
            }
            throw error;
          }
          toast.success("Statement deleted");
          router.push("/royalties/statements");
        }}
      />
    </>
  );
}

function NotProcessed() {
  return (
    <Card>
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <FileSearch className="size-6 text-fg-subtle" aria-hidden />
        <p className="text-sm font-semibold text-fg">Not processed yet</p>
        <p className="max-w-sm text-[13px] text-fg-muted">Lines appear once the statement has been mapped and processed.</p>
      </div>
    </Card>
  );
}
