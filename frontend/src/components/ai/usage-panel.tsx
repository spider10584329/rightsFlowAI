"use client";

import { Activity } from "lucide-react";

import { formatUsd } from "@/components/billing/usage";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { useAIUsage, type AIUsageRecord } from "@/lib/api/hooks/ai";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDate, formatDateTime, titleCase } from "@/lib/utils";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "invalid_output", label: "Invalid output" },
];

export function UsagePanel({ orgId }: { orgId: string }) {
  const table = useTableQueryState<"feature" | "status">({
    defaultPageSize: 25,
    defaultSort: { key: "created_at", order: "desc" },
    filterKeys: ["feature", "status"],
  });
  const usage = useAIUsage(orgId, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    feature: table.filters.feature || undefined,
    status: table.filters.status || undefined,
  });
  const data = usage.data;
  const features = data?.month_by_feature ?? [];

  const columns: DataTableColumn<AIUsageRecord>[] = [
    { id: "created_at", header: "When", sortKey: "created_at", cell: (row) => <span className="whitespace-nowrap tabular-nums text-fg-muted">{formatDateTime(row.created_at)}</span> },
    { id: "feature", header: "Feature", sortKey: "feature", cell: (row) => <span className="font-medium">{titleCase(row.feature)}</span> },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={row.status === "success" ? "success" : statusTone(row.status) === "neutral" ? "danger" : statusTone(row.status)} dot>
          {titleCase(row.status)}
        </Badge>
      ),
    },
    { id: "model", header: "Model", hideOnMobile: true, cell: (row) => <span className="font-mono text-xs">{row.provider} · {row.model}</span> },
    { id: "tokens", header: "Tokens in / out", align: "right", cell: (row) => <span className="tabular-nums">{row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}</span> },
    { id: "latency", header: "Latency", align: "right", hideOnMobile: true, cell: (row) => <span className="tabular-nums">{(row.latency_ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s</span> },
    { id: "cost", header: "Est. cost", align: "right", sortKey: "estimated_cost_usd", cell: (row) => <span className="tabular-nums">{formatUsd(row.estimated_cost_usd)}</span> },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-fg">This month by feature</h2>
          {data ? (
            <p className="text-xs text-fg-subtle">
              Since {formatDate(data.month_start)} · {data.month_total_requests.toLocaleString()} requests · {formatUsd(data.month_total_cost_usd)} estimated
            </p>
          ) : null}
        </div>
        {features.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-fg-muted">{usage.isLoading ? "Loading…" : "No AI requests this month."}</p>
        ) : (
          <ScrollRegion>
            <table className="w-full min-w-[36rem] text-[13px]">
              <caption className="sr-only">AI usage this month per feature</caption>
              <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <tr>
                  <th scope="col" className="px-5 py-2 font-semibold">Feature</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Requests</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Errors</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Input tokens</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Output tokens</th>
                  <th scope="col" className="px-5 py-2 text-right font-semibold">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {features.map((feature) => (
                  <tr key={feature.feature}>
                    <th scope="row" className="px-5 py-2 text-left font-medium text-fg">
                      <button type="button" className="hover:text-primary hover:underline" onClick={() => table.setFilter("feature", feature.feature)}>
                        {titleCase(feature.feature)}
                      </button>
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">{feature.requests.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{feature.errors.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{feature.input_tokens.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{feature.output_tokens.toLocaleString()}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{formatUsd(feature.estimated_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Card>

      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <h2 className="text-[15px] font-semibold text-fg sm:mr-auto">Request log</h2>
          <Select
            size="sm"
            className="sm:w-48"
            aria-label="Filter by feature"
            value={table.filters.feature || "all"}
            onValueChange={(value) => table.setFilter("feature", value === "all" ? null : value)}
            options={[
              { value: "all", label: "All features" },
              ...Array.from(new Set([...features.map((f) => f.feature), ...(table.filters.feature ? [table.filters.feature] : [])])).map((feature) => ({ value: feature, label: titleCase(feature) })),
            ]}
          />
          <Select
            size="sm"
            className="sm:w-40"
            aria-label="Filter by status"
            value={table.filters.status || "all"}
            onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}
            options={STATUS_OPTIONS}
          />
        </div>
        <DataTable
          columns={columns}
          data={data?.items}
          getRowId={(row) => row.id}
          getRowLabel={(row) => `${row.feature} at ${formatDateTime(row.created_at)}`}
          isLoading={usage.isLoading}
          isFetching={usage.isFetching}
          error={usage.error}
          onRetry={() => void usage.refetch()}
          sort={table.sort}
          onSortChange={table.setSort}
          caption="AI request log"
          renderExpanded={(row) => (row.error ? <p className="text-xs text-danger">Error: {row.error}</p> : null)}
          emptyState={<EmptyState compact icon={<Activity aria-hidden />} title="No AI requests recorded" description="Each AI request (successful or not) is logged here with tokens and estimated cost." />}
        />
        {data && data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
