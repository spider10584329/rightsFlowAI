"use client";

import { Banknote, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { NewBatchDialog } from "@/components/payouts/new-batch-dialog";
import { ProviderNotice } from "@/components/payouts/provider-notice";
import { BATCH_STATUSES, batchStatus } from "@/components/payouts/workflow";
import { Money } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { useBatches, type PayoutBatch } from "@/lib/api/hooks/payouts";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime } from "@/lib/utils";

export function PayoutsClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const table = useTableQueryState<"status">({ defaultPageSize: 25, defaultSort: { key: "created_at", order: "desc" }, filterKeys: ["status"] });
  const batches = useBatches(org.id, { page: table.page, page_size: table.pageSize, sort: table.sort?.key, order: table.sort?.order, status: table.filters.status || undefined });
  const [creating, setCreating] = useState(false);
  const canManage = can("manager");

  const columns: DataTableColumn<PayoutBatch>[] = [
    {
      id: "reference",
      header: "Batch",
      cell: (b) => (
        <div>
          <Link href={`/payouts/${b.id}`} className="font-mono text-[13px] font-medium text-fg hover:text-primary" onClick={(e) => e.stopPropagation()}>
            {b.reference}
          </Link>
          {b.notes ? <p className="max-w-[16rem] truncate text-xs text-fg-subtle">{b.notes}</p> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (b) => (
        <Badge tone={batchStatus(b.status).tone} dot>
          {batchStatus(b.status).label}
        </Badge>
      ),
    },
    { id: "payouts", header: "Payouts", align: "right", cell: (b) => <span className="tabular-nums">{b.payout_count.toLocaleString()}</span> },
    { id: "total", header: "Total", sortKey: "total_amount", align: "right", cell: (b) => <Money amount={b.total_amount} currency={b.currency} className="font-semibold" /> },
    { id: "currency", header: "Currency", hideOnMobile: true, cell: (b) => <span className="text-xs text-fg-muted">{b.currency}</span> },
    { id: "created", header: "Created", sortKey: "created_at", hideOnMobile: true, cell: (b) => <span className="whitespace-nowrap text-xs text-fg-muted">{formatDateTime(b.created_at)}</span> },
    {
      id: "paid",
      header: "Recorded paid",
      hideOnMobile: true,
      cell: (b) => <span className="whitespace-nowrap text-xs text-fg-muted">{b.paid_at ? formatDateTime(b.paid_at) : "—"}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Payouts"
        description="Batch payee balances into payouts, get them approved, pay recipients through your bank, then record the batch as paid."
        breadcrumbs={[{ label: "Payouts" }]}
        actions={
          <>
            <ButtonLink href="/payouts/payees" variant="outline" leftIcon={<Wallet aria-hidden />}>
              Payees
            </ButtonLink>
            {canManage ? (
              <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                New batch
              </Button>
            ) : null}
          </>
        }
      />
      <ProviderNotice orgId={org.id} className="mb-6" />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <Select
            size="sm"
            className="sm:w-52"
            aria-label="Filter by status"
            value={table.filters.status || "all"}
            onValueChange={(v) => table.setFilter("status", v === "all" ? null : v)}
            options={[{ value: "all", label: "All batches" }, ...BATCH_STATUSES.map((s) => ({ value: s, label: batchStatus(s).label }))]}
          />
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={batches.data?.items}
            getRowId={(b) => b.id}
            getRowLabel={(b) => b.reference}
            isLoading={batches.isLoading}
            isFetching={batches.isFetching}
            error={batches.error}
            onRetry={() => void batches.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            onRowClick={(b) => router.push(`/payouts/${b.id}`)}
            caption="Payout batches"
            emptyState={
              <EmptyState
                icon={<Banknote aria-hidden />}
                title={table.filters.status ? "No batches with this status" : "No payout batches yet"}
                description="Once royalties are posted, draft a batch to pay available balances."
                action={
                  canManage && !table.filters.status ? (
                    <Button size="sm" leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                      New batch
                    </Button>
                  ) : null
                }
              />
            }
          />
        </div>
        {batches.data && batches.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={batches.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>
      <NewBatchDialog orgId={org.id} open={creating} onOpenChange={setCreating} defaultCurrency={org.defaultCurrency} onCreated={(b) => router.push(`/payouts/${b.id}`)} />
    </>
  );
}
