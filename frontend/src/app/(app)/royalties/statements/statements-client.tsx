"use client";

import { Download, Eye, FileSpreadsheet, ListChecks, PenLine, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { STATEMENT_STATUSES, sourceCategoryLabel, statementStatus } from "@/components/royalties/labels";
import { Money, RatioMeter, StatementStatusBadge, formatPeriod } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { downloadStatementFile, useDeleteStatement, useRoyaltyReference, useStatements, type Statement } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime } from "@/lib/utils";

const FILTERS = ["status", "category", "q", "from", "to"] as const;

export function StatementsClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const canManage = can("manager");
  const isAdmin = can("admin");
  const table = useTableQueryState<(typeof FILTERS)[number]>({
    defaultPageSize: 25,
    defaultSort: { key: "created_at", order: "desc" },
    filterKeys: FILTERS,
  });
  const { filters } = table;
  const statements = useStatements(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    status: filters.status || undefined,
    source_category: filters.category || undefined,
    q: filters.q || undefined,
    period_from: filters.from || undefined,
    period_to: filters.to || undefined,
  });
  const categories = useRoyaltyReference("source-categories");
  const remove = useDeleteStatement(org.id);
  const [deleting, setDeleting] = useState<Statement | null>(null);
  const hasFilters = FILTERS.some((key) => filters[key]);

  const columns: DataTableColumn<Statement>[] = [
    {
      id: "source",
      header: "Source",
      sortKey: "source_name",
      cell: (s) => (
        <div className="min-w-0 max-w-[18rem]">
          <Link href={`/royalties/statements/${s.id}`} className="block truncate font-medium text-fg hover:text-primary" onClick={(e) => e.stopPropagation()}>
            {s.source_name}
          </Link>
          <p className="truncate text-xs text-fg-subtle">{s.file_name ?? "Manual statement"}</p>
        </div>
      ),
    },
    { id: "category", header: "Category", cell: (s) => <span className="text-[13px] text-fg-muted">{sourceCategoryLabel(s.source_category)}</span>, hideOnMobile: true },
    { id: "period", header: "Period", sortKey: "period_end", cell: (s) => <span className="whitespace-nowrap text-[13px]">{formatPeriod(s.period_start, s.period_end)}</span> },
    { id: "status", header: "Status", cell: (s) => <StatementStatusBadge status={s.status} /> },
    {
      id: "rows",
      header: "Rows · valid",
      hideOnMobile: true,
      cell: (s) => (s.status === "uploaded" ? <span className="text-xs text-fg-subtle">{s.total_rows.toLocaleString()} rows</span> : <RatioMeter value={s.valid_rows} total={s.total_rows} label="Valid rows" />),
    },
    {
      id: "matched",
      header: "Matched",
      hideOnMobile: true,
      cell: (s) => (s.valid_rows > 0 ? <RatioMeter value={s.matched_rows} total={s.valid_rows} label="Matched rows" /> : <span className="text-xs text-fg-subtle">—</span>),
    },
    {
      id: "total",
      header: "Total",
      sortKey: "total_amount",
      align: "right",
      cell: (s) => (
        <div className="text-right">
          <Money amount={s.total_amount} currency={s.currency} className="font-medium" />
          <p className="text-2xs text-fg-subtle">{s.currency}</p>
        </div>
      ),
    },
    { id: "uploaded", header: "Uploaded", sortKey: "created_at", hideOnMobile: true, cell: (s) => <span className="whitespace-nowrap text-xs text-fg-muted">{formatDateTime(s.created_at)}</span> },
  ];

  const actionsFor = (s: Statement): RowAction[] => {
    const actions: RowAction[] = [{ label: "Open", icon: <Eye aria-hidden />, onSelect: () => router.push(`/royalties/statements/${s.id}`) }];
    if (canManage && (s.status === "uploaded" || s.status === "failed")) {
      actions.push({ label: "Map columns & process", icon: <SlidersHorizontal aria-hidden />, onSelect: () => router.push(`/royalties/statements/new?statement=${s.id}`) });
    }
    if (s.file_id) {
      actions.push({
        label: "Download source file",
        icon: <Download aria-hidden />,
        onSelect: () => void downloadStatementFile(org.id, s.id).catch((e) => toast.error("Download failed", { description: errorMessage(e) })),
      });
    }
    if (isAdmin) {
      actions.push({ label: "Delete statement", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDeleting(s), disabled: s.status === "posted" });
    }
    return actions;
  };

  const categoryOptions = [{ value: "all", label: "All categories" }, ...(categories.data ?? []).map((c) => ({ value: c.code, label: c.name }))];

  return (
    <>
      <PageHeader
        title="Statements"
        description="Royalty statements from distributors, DSPs, PROs and publishers. Upload, map, match and reconcile them before calculating royalties."
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements" }]}
        actions={
          <>
            <ButtonLink href="/royalties/unmatched" variant="outline" leftIcon={<ListChecks aria-hidden />}>
              Unmatched
            </ButtonLink>
            {canManage ? (
              <>
                <ButtonLink href="/royalties/statements/manual" variant="outline" leftIcon={<PenLine aria-hidden />}>
                  Manual statement
                </ButtonLink>
                <ButtonLink href="/royalties/statements/new" leftIcon={<Upload aria-hidden />}>
                  Upload statement
                </ButtonLink>
              </>
            ) : null}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchInput value={filters.q} onChange={(v) => table.setFilter("q", v)} placeholder="Search source name" aria-label="Search statements" />
          <Select
            size="sm"
            className="lg:w-44"
            aria-label="Filter by status"
            value={filters.status || "all"}
            onValueChange={(v) => table.setFilter("status", v === "all" ? null : v)}
            options={[{ value: "all", label: "All statuses" }, ...STATEMENT_STATUSES.map((s) => ({ value: s, label: statementStatus(s).label }))]}
          />
          <Select
            size="sm"
            className="lg:w-56"
            aria-label="Filter by source category"
            value={filters.category || "all"}
            onValueChange={(v) => table.setFilter("category", v === "all" ? null : v)}
            options={categoryOptions}
          />
          <div className="flex items-center gap-2">
            <label className="shrink-0 text-xs text-fg-muted" htmlFor="period-from">
              Period end
            </label>
            <Input id="period-from" type="date" className="h-8 min-w-0 flex-1 text-[13px] sm:w-[9.5rem] sm:flex-none" value={filters.from} onChange={(e) => table.setFilter("from", e.target.value)} aria-label="Period end from" />
            <span className="text-xs text-fg-subtle" aria-hidden>
              –
            </span>
            <Input type="date" className="h-8 min-w-0 flex-1 text-[13px] sm:w-[9.5rem] sm:flex-none" value={filters.to} onChange={(e) => table.setFilter("to", e.target.value)} aria-label="Period end to" />
          </div>
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={table.reset} className="lg:ml-auto">
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={statements.data?.items}
            getRowId={(s) => s.id}
            getRowLabel={(s) => s.source_name}
            isLoading={statements.isLoading}
            isFetching={statements.isFetching}
            error={statements.error}
            onRetry={() => void statements.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            rowActions={actionsFor}
            onRowClick={(s) => router.push(`/royalties/statements/${s.id}`)}
            caption="Royalty statements"
            emptyState={
              <EmptyState
                icon={<FileSpreadsheet aria-hidden />}
                title={hasFilters ? "No statements match these filters" : "No statements yet"}
                description={
                  hasFilters
                    ? "Try a different status, category or period."
                    : "Upload a CSV or XLSX statement from a distributor, DSP or society to start calculating royalties."
                }
                action={
                  hasFilters ? (
                    <Button variant="outline" size="sm" onClick={table.reset}>
                      Clear filters
                    </Button>
                  ) : canManage ? (
                    <>
                      <ButtonLink href="/royalties/statements/new" size="sm" leftIcon={<Upload aria-hidden />}>
                        Upload statement
                      </ButtonLink>
                      <ButtonLink href="/royalties/statements/manual" size="sm" variant="outline" leftIcon={<PenLine aria-hidden />}>
                        Enter manually
                      </ButtonLink>
                    </>
                  ) : null
                }
              />
            }
          />
        </div>
        {statements.data && statements.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={statements.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete statement?"
        description={
          deleting
            ? `${deleting.source_name} (${formatPeriod(deleting.period_start, deleting.period_end)}) and its lines and unposted calculations will be deleted. Statements with posted royalties cannot be deleted.`
            : undefined
        }
        confirmLabel="Delete statement"
        confirmText="DELETE"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
          } catch (error) {
            if (isApiError(error) && error.code === "statement_posted") {
              throw new Error("Royalties from this statement are posted to the ledger, so it is part of the financial record and cannot be deleted. Reverse the run first if it is wrong.");
            }
            throw error;
          }
          toast.success("Statement deleted");
        }}
      />
    </>
  );
}
