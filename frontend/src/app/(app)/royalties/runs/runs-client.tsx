"use client";

import { Calculator, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { basisLabel } from "@/components/royalties/allocation-explanation";
import { runStatus } from "@/components/royalties/labels";
import { Money, RunStatusBadge, formatIsoDate } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { useRuns, type Run } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime } from "@/lib/utils";

const STATUSES = ["calculated", "posted", "reversed", "discarded"];

export function RunsClient() {
  const { org } = useOrg();
  const router = useRouter();
  const table = useTableQueryState<"status">({ defaultPageSize: 25, defaultSort: { key: "created_at", order: "desc" }, filterKeys: ["status"] });
  const runs = useRuns(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    status: table.filters.status || undefined,
  });

  const columns: DataTableColumn<Run>[] = [
    {
      id: "created",
      header: "Calculated",
      sortKey: "created_at",
      cell: (r) => (
        <Link href={`/royalties/runs/${r.id}`} className="whitespace-nowrap font-medium text-fg hover:text-primary" onClick={(e) => e.stopPropagation()}>
          {formatDateTime(r.created_at)}
        </Link>
      ),
    },
    {
      id: "statement",
      header: "Statement",
      cell: (r) => (
        <div className="min-w-0 max-w-[16rem]">
          <p className="truncate text-[13px] text-fg">{r.statement_source ?? "Statement"}</p>
          <p className="text-xs text-fg-subtle">Period end {formatIsoDate(r.statement_period_end)}</p>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (r) => <RunStatusBadge status={r.status} /> },
    { id: "basis", header: "Basis", hideOnMobile: true, cell: (r) => <span className="text-xs text-fg-muted">{basisLabel(r.allocation_basis)}</span> },
    { id: "lines", header: "Lines", align: "right", hideOnMobile: true, cell: (r) => <span className="tabular-nums text-fg-muted">{r.line_count.toLocaleString()}</span> },
    { id: "input", header: "Input", align: "right", cell: (r) => <Money amount={r.total_input} currency={r.currency} /> },
    { id: "payable", header: "Payable", align: "right", cell: (r) => <Money amount={r.total_payable} currency={r.currency} className="font-medium" /> },
    { id: "retained", header: "Retained", align: "right", hideOnMobile: true, cell: (r) => <Money amount={r.total_retained} currency={r.currency} /> },
    { id: "unallocated", header: "Unallocated", align: "right", cell: (r) => <Money amount={r.total_unallocated} currency={r.currency} className="text-warning-soft-fg" /> },
  ];

  return (
    <>
      <PageHeader
        title="Processing"
        description="Calculation runs turn processed statements into payable, retained and unallocated amounts. Review, verify and post runs to the payee ledger."
        breadcrumbs={[{ label: "Royalties" }, { label: "Processing" }]}
        actions={
          <ButtonLink href="/royalties/statements" variant="outline" leftIcon={<FileSpreadsheet aria-hidden />}>
            Statements
          </ButtonLink>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <Select
            size="sm"
            className="sm:w-48"
            aria-label="Filter by run status"
            value={table.filters.status || "all"}
            onValueChange={(v) => table.setFilter("status", v === "all" ? null : v)}
            options={[{ value: "all", label: "All runs" }, ...STATUSES.map((s) => ({ value: s, label: runStatus(s).label }))]}
          />
          <p className="text-xs text-fg-subtle sm:ml-auto">Amounts are in each statement&apos;s currency.</p>
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={runs.data?.items}
            getRowId={(r) => r.id}
            getRowLabel={(r) => `${r.statement_source ?? "Run"} ${formatDateTime(r.created_at)}`}
            isLoading={runs.isLoading}
            isFetching={runs.isFetching}
            error={runs.error}
            onRetry={() => void runs.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            onRowClick={(r) => router.push(`/royalties/runs/${r.id}`)}
            caption="Calculation runs"
            emptyState={
              <EmptyState
                icon={<Calculator aria-hidden />}
                title={table.filters.status ? "No runs with this status" : "No calculations yet"}
                description="Process a statement, then calculate royalties from its Calculation tab."
                action={
                  <ButtonLink href="/royalties/statements" size="sm" variant="outline">
                    Go to statements
                  </ButtonLink>
                }
              />
            }
          />
        </div>
        {runs.data && runs.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={runs.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>
    </>
  );
}
