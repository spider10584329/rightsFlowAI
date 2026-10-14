"use client";

import { useState } from "react";

import { pivotSummary } from "@/components/royalties/summary";
import { Money } from "@/components/royalties/shared";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunSummary, type Run, type SummaryGroupBy } from "@/lib/api/hooks/royalties";

export function RunSummaryCard({ orgId, run }: { orgId: string; run: Run }) {
  const [groupBy, setGroupBy] = useState<SummaryGroupBy>("party");
  const summary = useRunSummary(orgId, run.id, groupBy);
  const rows = summary.data ? pivotSummary(summary.data, groupBy) : [];
  const header = groupBy === "party" ? "Party" : groupBy === "reason" ? "Reason" : "Rights type";

  return (
    <Card>
      <CardHeader title="Summary" description="Allocated amounts grouped for review. Sums are exact." />
      <div className="px-5 pb-3">
        <SegmentedControl<SummaryGroupBy>
          aria-label="Group summary by"
          value={groupBy}
          onValueChange={setGroupBy}
          options={[
            { value: "party", label: "By party" },
            { value: "reason", label: "By reason" },
            { value: "rights_type", label: "By rights type" },
          ]}
        />
      </div>
      {summary.isLoading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} compact />
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-fg-muted">No allocations in this run.</p>
      ) : (
        <ScrollRegion>
          <table className="w-full min-w-[40rem] text-[13px]">
            <caption className="sr-only">Run summary by {header.toLowerCase()}</caption>
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <th scope="col" className="px-5 py-2 text-left font-medium">
                  {header}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Payable
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Retained
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Unallocated
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border last:border-0">
                  <th scope="row" className="px-5 py-2.5 text-left font-medium text-fg">
                    {row.label}
                    <span className="ml-2 text-xs font-normal text-fg-subtle">
                      {row.count.toLocaleString()} alloc. {row.currency !== run.currency ? `· ${row.currency}` : ""}
                    </span>
                  </th>
                  <td className="px-3 py-2.5 text-right">
                    <Money amount={row.payable} currency={row.currency} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Money amount={row.retained} currency={row.currency} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Money amount={row.unallocated} currency={row.currency} />
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold">
                    <Money amount={row.total} currency={row.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Card>
  );
}
