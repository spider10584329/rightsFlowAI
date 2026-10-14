"use client";

import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useState } from "react";

import { AllocationExplanation } from "@/components/royalties/allocation-explanation";
import { ALLOCATION_TYPES, REASON_EXPLANATIONS, allocationType, reasonInfo } from "@/components/royalties/labels";
import { formatPercent } from "@/components/royalties/money";
import { AllocationTypeBadge, Money } from "@/components/royalties/shared";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { useAllocations, useRunSummary, type Allocation, type Run } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { titleCase } from "@/lib/utils";

const FILTERS = ["type", "party", "reason"] as const;

export function AllocationsCard({ orgId, run }: { orgId: string; run: Run }) {
  const table = useTableQueryState<(typeof FILTERS)[number]>({ defaultPageSize: 50, defaultSort: { key: "amount", order: "desc" }, filterKeys: FILTERS });
  const { filters } = table;
  const allocations = useAllocations(orgId, run.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    allocation_type: filters.type || undefined,
    party_id: filters.party || undefined,
    reason: filters.reason || undefined,
  });
  const parties = useRunSummary(orgId, run.id, "party");
  const reasons = useRunSummary(orgId, run.id, "reason");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const partyOptions = new Map<string, string>();
  for (const row of parties.data ?? []) if (row.key) partyOptions.set(row.key, row.label ?? row.key);
  const reasonOptions = new Set<string>();
  for (const row of reasons.data ?? []) if (row.key) reasonOptions.add(row.key);
  const hasFilters = FILTERS.some((key) => filters[key]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: DataTableColumn<Allocation>[] = [
    {
      id: "expand",
      header: <span className="sr-only">Explanation</span>,
      className: "w-10",
      cell: (a) => (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded.has(a.id)}
          aria-label={expanded.has(a.id) ? "Hide explanation" : "Show explanation"}
          onClick={(e) => {
            e.stopPropagation();
            toggle(a.id);
          }}
        >
          {expanded.has(a.id) ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      ),
    },
    { id: "type", header: "Type", cell: (a) => <AllocationTypeBadge type={a.allocation_type} /> },
    {
      id: "party",
      header: "Party",
      cell: (a) => (
        <div className="min-w-0 max-w-[14rem]">
          <p className="truncate font-medium text-fg">{a.party_name ?? <span className="text-fg-subtle">—</span>}</p>
          {a.reason ? <p className="truncate text-xs text-fg-muted">{reasonInfo(a.reason).label}</p> : null}
        </div>
      ),
    },
    { id: "rights", header: "Rights · territory", hideOnMobile: true, cell: (a) => <span className="text-xs text-fg-muted">{[a.rights_type ? titleCase(a.rights_type) : null, a.territory].filter(Boolean).join(" · ") || "—"}</span> },
    { id: "share", header: "Share", align: "right", hideOnMobile: true, cell: (a) => <span className="tabular-nums text-fg-muted">{a.share_percent ? formatPercent(a.share_percent) : "—"}</span> },
    { id: "rate", header: "Rate", align: "right", hideOnMobile: true, cell: (a) => <span className="tabular-nums text-fg-muted">{a.rate_percent ? formatPercent(a.rate_percent) : "—"}</span> },
    { id: "base", header: "Base", align: "right", hideOnMobile: true, cell: (a) => <Money amount={a.base_amount} currency={a.currency} precision="exact" className="text-fg-muted" /> },
    { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (a) => <Money amount={a.amount} currency={a.currency} precision="exact" toneNegative className="font-semibold" /> },
  ];

  return (
    <Card>
      <CardHeader title="Allocations" description="Every line's split. Expand a row for a plain-language explanation of share, rate, basis and contract term." />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:flex-wrap md:items-center">
        <Select
          size="sm"
          className="md:w-40"
          aria-label="Filter by allocation type"
          value={filters.type || "all"}
          onValueChange={(v) => table.setFilter("type", v === "all" ? null : v)}
          options={[{ value: "all", label: "All types" }, ...ALLOCATION_TYPES.map((t) => ({ value: t, label: allocationType(t).label }))]}
        />
        <Select
          size="sm"
          className="md:w-56"
          aria-label="Filter by party"
          value={filters.party || "all"}
          onValueChange={(v) => table.setFilter("party", v === "all" ? null : v)}
          options={[{ value: "all", label: "All parties" }, ...[...partyOptions].map(([value, label]) => ({ value, label }))]}
        />
        <Select
          size="sm"
          className="md:w-56"
          aria-label="Filter by reason"
          value={filters.reason || "all"}
          onValueChange={(v) => table.setFilter("reason", v === "all" ? null : v)}
          options={[
            { value: "all", label: "All reasons" },
            ...[...(reasonOptions.size > 0 ? reasonOptions : new Set(Object.keys(REASON_EXPLANATIONS)))].map((value) => ({ value, label: reasonInfo(value).label })),
          ]}
        />
        {hasFilters ? (
          <Button variant="ghost" size="sm" className="md:ml-auto" onClick={table.reset}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={allocations.data?.items}
          getRowId={(a) => a.id}
          getRowLabel={(a) => `${allocationType(a.allocation_type).label} ${a.party_name ?? ""}`.trim()}
          isLoading={allocations.isLoading}
          isFetching={allocations.isFetching}
          error={allocations.error}
          onRetry={() => void allocations.refetch()}
          sort={table.sort}
          onSortChange={table.setSort}
          onRowClick={(a) => toggle(a.id)}
          renderExpanded={(a) => (expanded.has(a.id) ? <AllocationExplanation allocation={a} statementId={run.statement_id} /> : null)}
          caption="Allocations"
          emptyState={<EmptyState compact icon={<Layers aria-hidden />} title="No allocations match" description="Try another type, party or reason." />}
        />
      </div>
      {allocations.data && allocations.data.total > 0 ? (
        <div className="border-t border-border">
          <Pagination page={table.page} pageSize={table.pageSize} total={allocations.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} pageSizeOptions={[25, 50, 100, 200]} />
        </div>
      ) : null}
    </Card>
  );
}
