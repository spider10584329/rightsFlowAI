"use client";

import { Banknote, Lock, UserPlus, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { BalanceSummary } from "@/components/payouts/balances";
import { PayeeFormDialog } from "@/components/payouts/payee-form-dialog";
import { paymentMethodLabel, paymentReferenceSummary } from "@/components/payouts/workflow";
import { Money } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { usePayees, type Payee } from "@/lib/api/hooks/payouts";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";

const FILTERS = ["q", "status", "balance"] as const;

export function PayeesClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const table = useTableQueryState<(typeof FILTERS)[number]>({ defaultPageSize: 25, defaultSort: { key: "display_name", order: "asc" }, filterKeys: FILTERS });
  const { filters } = table;
  const payees = usePayees(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    q: filters.q || undefined,
    active: filters.status === "active" ? true : filters.status === "inactive" ? false : undefined,
    with_balance: filters.balance === "1" ? true : undefined,
  });
  const [creating, setCreating] = useState(false);
  const hasFilters = FILTERS.some((key) => filters[key]);

  const columns: DataTableColumn<Payee>[] = [
    {
      id: "payee",
      header: "Payee",
      sortKey: "display_name",
      cell: (p) => (
        <div className="min-w-0 max-w-[16rem]">
          <Link href={`/payouts/payees/${p.id}`} className="block truncate font-medium text-fg hover:text-primary" onClick={(e) => e.stopPropagation()}>
            {p.display_name}
          </Link>
          <p className="truncate text-xs text-fg-subtle">{p.party_name && p.party_name !== p.display_name ? p.party_name : (p.email ?? "—")}</p>
        </div>
      ),
    },
    {
      id: "method",
      header: "Payment method",
      hideOnMobile: true,
      cell: (p) => (
        <div className="text-xs">
          <p className="text-fg">{paymentMethodLabel(p.payment_method)}</p>
          <p className="text-fg-subtle">{paymentReferenceSummary(p.payment_reference) ?? "No reference"}</p>
        </div>
      ),
    },
    { id: "min", header: "Minimum", align: "right", hideOnMobile: true, cell: (p) => <Money amount={p.minimum_payout} currency={p.currency} className="text-xs text-fg-muted" /> },
    {
      id: "status",
      header: "Status",
      cell: (p) => (
        <div className="flex flex-wrap gap-1">
          {p.is_active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="neutral" dot>Inactive</Badge>}
          {p.hold_payments ? <Badge tone="warning">On hold</Badge> : null}
        </div>
      ),
    },
    { id: "balances", header: "Balance · available", align: "right", cell: (p) => <BalanceSummary balances={p.balances} /> },
  ];

  return (
    <>
      <PageHeader
        title="Payees"
        description="Everyone you pay royalties to, with ledger balances per currency. Payees are created automatically when a run is posted, or manually here."
        breadcrumbs={[{ label: "Payouts", href: "/payouts" }, { label: "Payees" }]}
        actions={
          <>
            <ButtonLink href="/payouts" variant="outline" leftIcon={<Banknote aria-hidden />}>
              Payout batches
            </ButtonLink>
            {can("manager") ? (
              <Button leftIcon={<UserPlus aria-hidden />} onClick={() => setCreating(true)}>
                New payee
              </Button>
            ) : null}
          </>
        }
      />
      <Alert tone="info" className="mb-6">
        <span className="flex items-center gap-1.5">
          <Lock className="size-3.5" aria-hidden /> Ledger balances are accounting figures, not confirmed bank payments. Full account numbers are never stored.
        </span>
      </Alert>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center">
          <SearchInput value={filters.q} onChange={(v) => table.setFilter("q", v)} placeholder="Search name, email or party" aria-label="Search payees" />
          <Select
            size="sm"
            className="md:w-40"
            aria-label="Filter by status"
            value={filters.status || "all"}
            onValueChange={(v) => table.setFilter("status", v === "all" ? null : v)}
            options={[
              { value: "all", label: "All payees" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
          />
          <div className="flex items-center gap-2">
            <Switch id="with-balance" checked={filters.balance === "1"} onCheckedChange={(v) => table.setFilter("balance", v ? "1" : null)} />
            <Label htmlFor="with-balance" className="font-normal text-fg-muted">
              With a balance only
            </Label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={payees.data?.items}
            getRowId={(p) => p.id}
            getRowLabel={(p) => p.display_name}
            isLoading={payees.isLoading}
            isFetching={payees.isFetching}
            error={payees.error}
            onRetry={() => void payees.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            onRowClick={(p) => router.push(`/payouts/payees/${p.id}`)}
            caption="Payees"
            emptyState={
              <EmptyState
                icon={<Wallet aria-hidden />}
                title={hasFilters ? "No payees match" : "No payees yet"}
                description={hasFilters ? "Try a different search or filter." : "Post a calculation run to create payees automatically, or add one for an advance or adjustment."}
                action={
                  hasFilters ? (
                    <Button size="sm" variant="outline" onClick={table.reset}>
                      Clear filters
                    </Button>
                  ) : can("manager") ? (
                    <Button size="sm" leftIcon={<UserPlus aria-hidden />} onClick={() => setCreating(true)}>
                      New payee
                    </Button>
                  ) : null
                }
              />
            }
          />
        </div>
        {payees.data && payees.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={payees.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>
      <PayeeFormDialog orgId={org.id} open={creating} onOpenChange={setCreating} defaultCurrency={org.defaultCurrency} onSaved={(p) => router.push(`/payouts/payees/${p.id}`)} />
    </>
  );
}
