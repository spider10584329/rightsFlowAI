"use client";

import { AlarmClock, Banknote, CircleCheck, Eye, FilePlus2, FileSignature, Files, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CONTRACT_STATUS_LABELS, CONTRACT_STATUSES, CONTRACT_TYPES, contractStatusLabel, contractStatusTone, expiryDisplay, formatMoney } from "@/components/contracts/contract-format";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { useContracts, useContractsSummary, useDeleteContract, useExpiringContracts, type ContractListItem } from "@/lib/api/hooks/contracts";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDate, titleCase } from "@/lib/utils";

const FILTERS = ["q", "type", "status", "expiring"] as const;
const EXPIRING_OPTIONS = ["30", "60", "90", "180"];

export function ContractsClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const table = useTableQueryState({ filterKeys: FILTERS, defaultSort: { key: "created_at", order: "desc" } });
  const { filters } = table;
  const expiringDays = EXPIRING_OPTIONS.includes(filters.expiring) ? Number(filters.expiring) : undefined;
  const contracts = useContracts(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    q: filters.q || undefined,
    type: filters.type || undefined,
    status: filters.status || undefined,
    expiring_within_days: expiringDays,
  });
  const summary = useContractsSummary(org.id);
  const expiring = useExpiringContracts(org.id);
  const remove = useDeleteContract(org.id);
  const [deleting, setDeleting] = useState<ContractListItem | null>(null);
  const hasFilters = FILTERS.some((key) => filters[key]);

  const columns: DataTableColumn<ContractListItem>[] = [
    {
      id: "title",
      header: "Contract",
      sortKey: "title",
      cell: (contract) => (
        <div className="min-w-0 max-w-md">
          <Link href={`/contracts/${contract.id}`} className="font-medium text-fg hover:text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
            {contract.title}
          </Link>
          <p className="truncate text-xs text-fg-subtle">{[contract.reference, contract.party_names.slice(0, 3).join(", ")].filter(Boolean).join(" · ") || "No parties"}</p>
        </div>
      ),
    },
    { id: "type", header: "Type", hideOnMobile: true, cell: (contract) => <Badge tone="neutral">{titleCase(contract.contract_type)}</Badge> },
    {
      id: "status",
      header: "Status",
      cell: (contract) => (
        <Badge tone={contractStatusTone(contract.status)} dot>
          {contractStatusLabel(contract.status)}
        </Badge>
      ),
    },
    { id: "start", header: "Start", sortKey: "start_date", hideOnMobile: true, cell: (contract) => formatDate(contract.start_date) },
    {
      id: "end",
      header: "End",
      sortKey: "end_date",
      cell: (contract) => {
        const expiry = expiryDisplay(contract.expiry_state, contract.days_until_expiry, contract.auto_renew);
        return (
          <div className="flex flex-col items-start gap-1">
            <span className="text-[13px]">{formatDate(contract.end_date)}</span>
            {contract.expiry_state !== "none" ? <Badge tone={expiry.tone}>{expiry.label}</Badge> : null}
          </div>
        );
      },
    },
    { id: "advance", header: "Advance", align: "right", hideOnMobile: true, cell: (contract) => <span className="tabular-nums">{formatMoney(contract.advance_amount, contract.currency)}</span> },
  ];

  const actions = (contract: ContractListItem): RowAction[] => [
    { label: "View", icon: <Eye aria-hidden />, onSelect: () => router.push(`/contracts/${contract.id}`) },
    ...(can("manager") ? [{ label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => router.push(`/contracts/${contract.id}/edit`) }] : []),
    ...(can("admin") ? [{ label: "Delete", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDeleting(contract) }] : []),
  ];

  const advances = Object.entries(summary.data?.advances_by_currency ?? {});
  const expiringList = expiring.data ?? [];

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Agreements, their terms and documents, with expiry tracking and AI-assisted review."
        breadcrumbs={[{ label: "Contracts" }]}
        actions={
          can("manager") ? (
            <ButtonLink href="/contracts/new" leftIcon={<FilePlus2 aria-hidden />}>
              New contract
            </ButtonLink>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Contracts" icon={<Files aria-hidden />} loading={summary.isLoading} value={summary.data?.total.toLocaleString() ?? "—"} hint={summary.data ? `${summary.data.by_status.draft ?? 0} draft · ${summary.data.by_status.pending_signature ?? 0} pending signature` : undefined} />
        <StatCard label="Active" icon={<CircleCheck aria-hidden />} loading={summary.isLoading} value={summary.data?.active.toLocaleString() ?? "—"} hint={summary.data ? `${summary.data.by_status.expired ?? 0} expired · ${summary.data.by_status.terminated ?? 0} terminated` : undefined} />
        <StatCard
          label="Expiring in 30 days"
          icon={<AlarmClock aria-hidden />}
          loading={summary.isLoading}
          value={summary.data?.expiring_within_30_days.toLocaleString() ?? "—"}
          hint={summary.data ? `${summary.data.expiring_within_60_days} within 60 · ${summary.data.expiring_within_90_days} within 90 days` : undefined}
        />
        <StatCard
          label="Advances"
          icon={<Banknote aria-hidden />}
          loading={summary.isLoading}
          value={advances.length === 0 ? "—" : formatMoney(advances[0][1], advances[0][0])}
          hint={advances.length > 1 ? advances.slice(1).map(([currency, amount]) => formatMoney(amount, currency)).join(" · ") : "Excludes terminated contracts"}
        />
      </div>

      {expiringList.length > 0 ? (
        <Alert
          tone="warning"
          className="mt-6"
          title={`${expiringList.length} ${expiringList.length === 1 ? "contract needs" : "contracts need"} attention before expiry`}
          action={
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => table.setFilter("expiring", "90")}>
              Show expiring
            </button>
          }
        >
          <ul className="mt-1 space-y-0.5">
            {expiringList.slice(0, 4).map((contract) => (
              <li key={contract.id}>
                <Link href={`/contracts/${contract.id}`} className="font-medium underline-offset-2 hover:underline">
                  {contract.title}
                </Link>{" "}
                — {expiryDisplay(contract.expiry_state, contract.days_until_expiry, contract.auto_renew).label} ({formatDate(contract.end_date)})
              </li>
            ))}
            {expiringList.length > 4 ? <li>and {expiringList.length - 4} more</li> : null}
          </ul>
        </Alert>
      ) : null}

      <Card className="mt-6">
        <div className="flex flex-col gap-2 border-b border-border px-5 py-3 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchInput value={filters.q} onChange={(value) => table.setFilter("q", value)} placeholder="Search title, reference or party" aria-label="Search contracts" />
          <Select
            size="sm"
            className="lg:w-40"
            aria-label="Filter by type"
            value={filters.type || "all"}
            onValueChange={(value) => table.setFilter("type", value === "all" ? null : value)}
            options={[{ value: "all", label: "All types" }, ...CONTRACT_TYPES.map((value) => ({ value, label: titleCase(value) }))]}
          />
          <Select
            size="sm"
            className="lg:w-44"
            aria-label="Filter by status"
            value={filters.status || "all"}
            onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}
            options={[{ value: "all", label: "All statuses" }, ...CONTRACT_STATUSES.map((value) => ({ value, label: CONTRACT_STATUS_LABELS[value] }))]}
          />
          <Select
            size="sm"
            className="lg:w-48"
            aria-label="Filter by expiry"
            value={expiringDays ? String(expiringDays) : "any"}
            onValueChange={(value) => table.setFilter("expiring", value === "any" ? null : value)}
            options={[{ value: "any", label: "Any end date" }, ...EXPIRING_OPTIONS.map((value) => ({ value, label: `Active, ending ≤ ${value} days` }))]}
          />
          {hasFilters ? (
            <button type="button" className="text-[13px] text-fg-muted hover:text-fg lg:ml-auto" onClick={table.reset}>
              Reset filters
            </button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={contracts.data?.items}
            getRowId={(contract) => contract.id}
            getRowLabel={(contract) => contract.title}
            isLoading={contracts.isLoading}
            isFetching={contracts.isFetching}
            error={contracts.error}
            onRetry={() => void contracts.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            rowActions={actions}
            onRowClick={(contract) => router.push(`/contracts/${contract.id}`)}
            caption="Contracts"
            emptyState={
              <EmptyState
                compact
                icon={<FileSignature aria-hidden />}
                title={hasFilters ? "No contracts match" : "No contracts yet"}
                description={hasFilters ? "Try a different search or filter." : "Add your publishing, licensing and distribution agreements to track terms and expiry."}
                action={
                  !hasFilters && can("manager") ? (
                    <ButtonLink href="/contracts/new" size="sm" variant="outline">
                      New contract
                    </ButtonLink>
                  ) : null
                }
              />
            }
            footer={
              contracts.data && contracts.data.total > 0 ? (
                <Pagination page={table.page} pageSize={table.pageSize} total={contracts.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
              ) : null
            }
          />
        </div>
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete contract?"
        description={deleting ? `“${deleting.title}” and its documents will be deleted. Contracts referenced by royalty data cannot be deleted.` : undefined}
        confirmLabel="Delete contract"
        confirmText={deleting?.reference ?? undefined}
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success("Contract deleted");
        }}
      />
    </>
  );
}
