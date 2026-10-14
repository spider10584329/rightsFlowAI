"use client";

import { ArrowRight, Calculator, History } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { basisLabel } from "@/components/royalties/allocation-explanation";
import { Money, RunStatusBadge } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useCalculateStatement, useRuns, type Run, type Statement } from "@/lib/api/hooks/royalties";
import { formatDateTime } from "@/lib/utils";

export function CalculationTab({ orgId, statement }: { orgId: string; statement: Statement }) {
  const { can } = useOrg();
  const router = useRouter();
  const runs = useRuns(orgId, { page: 1, page_size: 50, statement_id: statement.id });
  const calculate = useCalculateStatement(orgId);
  const [confirm, setConfirm] = useState(false);
  const canCalculate = can("manager") && (statement.status === "processed" || statement.status === "calculated");
  const latest = runs.data?.items.find((r) => r.status === "calculated" || r.status === "posted") ?? runs.data?.items[0];

  const run = async () => {
    const result = await calculate.mutateAsync(statement.id);
    toast.success("Royalties calculated", { description: "Review the allocations before posting to the ledger." });
    router.push(`/royalties/runs/${result.id}`);
  };

  const columns: DataTableColumn<Run>[] = [
    { id: "created", header: "Calculated", cell: (r) => <span className="whitespace-nowrap text-[13px]">{formatDateTime(r.created_at)}</span> },
    { id: "status", header: "Status", cell: (r) => <RunStatusBadge status={r.status} /> },
    { id: "basis", header: "Basis", hideOnMobile: true, cell: (r) => <span className="text-xs text-fg-muted">{basisLabel(r.allocation_basis)}</span> },
    { id: "payable", header: "Payable", align: "right", cell: (r) => <Money amount={r.total_payable} currency={r.currency} /> },
    { id: "retained", header: "Retained", align: "right", hideOnMobile: true, cell: (r) => <Money amount={r.total_retained} currency={r.currency} /> },
    { id: "unallocated", header: "Unallocated", align: "right", cell: (r) => <Money amount={r.total_unallocated} currency={r.currency} /> },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Calculate royalties"
          description="Allocates every valid line to payable, retained and unallocated amounts using ownership shares and contract terms. Calculating never touches the ledger — posting does."
          actions={
            canCalculate ? (
              <Button
                leftIcon={<Calculator aria-hidden />}
                loading={calculate.isPending}
                onClick={() => (statement.status === "calculated" ? setConfirm(true) : void run().catch((e) => toast.error("Calculation failed", { description: errorMessage(e) })))}
              >
                {statement.status === "calculated" ? "Recalculate" : "Calculate"}
              </Button>
            ) : null
          }
        />
        <CardBody>
          {statement.status === "uploaded" || statement.status === "queued" || statement.status === "processing" || statement.status === "failed" ? (
            <Alert tone="info" title="Process the statement first">
              Calculation needs processed lines. Finish mapping and processing, then come back.
            </Alert>
          ) : statement.status === "posted" ? (
            <Alert tone="success" title="Posted">
              This statement&apos;s royalties are posted. To change them, reverse the posted run, fix the data and recalculate.
            </Alert>
          ) : statement.valid_rows > statement.matched_rows ? (
            <Alert tone="warning" title={`${(statement.valid_rows - statement.matched_rows).toLocaleString()} valid lines are unmatched`}>
              Their income will be held as unallocated (reason: unmatched line). Match them first to allocate it.
            </Alert>
          ) : null}
          {latest ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium text-fg">Latest run</span>
                <RunStatusBadge status={latest.status} />
                <span className="text-fg-subtle">{formatDateTime(latest.created_at)}</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Input" value={<Money amount={latest.total_input} currency={latest.currency} />} hint={`${latest.line_count.toLocaleString()} lines`} />
                <StatCard label="Payable" value={<Money amount={latest.total_payable} currency={latest.currency} />} hint="Owed to external parties" />
                <StatCard label="Retained" value={<Money amount={latest.total_retained} currency={latest.currency} />} hint="Kept by your organization" />
                <StatCard label="Unallocated" value={<Money amount={latest.total_unallocated} currency={latest.currency} />} hint="Held for review" />
              </div>
              <ButtonLink href={`/royalties/runs/${latest.id}`} variant="outline" rightIcon={<ArrowRight aria-hidden />}>
                Open run details
              </ButtonLink>
            </div>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <History className="size-4 text-fg-subtle" aria-hidden /> Run history
            </span>
          }
          description="Recalculating discards the previous unposted run; posted and reversed runs stay for the audit trail."
        />
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={runs.data?.items}
            getRowId={(r) => r.id}
            isLoading={runs.isLoading}
            error={runs.error}
            onRetry={() => void runs.refetch()}
            onRowClick={(r) => router.push(`/royalties/runs/${r.id}`)}
            caption="Calculation runs for this statement"
            emptyState={<EmptyState compact icon={<Calculator aria-hidden />} title="No calculations yet" description="Calculate royalties to see the allocation breakdown." />}
          />
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Recalculate royalties?"
        description="The current unposted run will be discarded and replaced with a fresh calculation from today's ownership and contract data."
        confirmLabel="Recalculate"
        tone="primary"
        onConfirm={run}
      />
    </div>
  );
}
