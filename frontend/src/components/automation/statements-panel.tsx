"use client";

import { FileCheck2, RotateCcw, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import {
  STATEMENT_AUTOMATION_STATES,
  useAutomationStatements,
  useRetryAutomationStatement,
  useStatementsNeedingAttention,
  type StatementAutomationRecord,
  type StatementAutomationState,
} from "@/lib/api/hooks/automation";

import { When } from "./automation-activity";
import {
  canRetryStatementState,
  errorCategoryLabel,
  statementMappingPath,
  statementPath,
  statementStateLabel,
  statementStateTone,
} from "./automation-format";

type StateFilter = "attention" | StatementAutomationState;

function statementName(record: StatementAutomationRecord): string {
  return record.source_name?.trim() || `Statement ${record.statement_id.slice(0, 8)}`;
}

/** The action a row offers: Retry where automation gave up, a mapping link where a person must confirm columns. */
export function StatementAction({
  record,
  canAct,
  retrying,
  onRetry,
}: {
  record: StatementAutomationRecord;
  canAct: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const name = statementName(record);
  if (record.state === "awaiting_mapping") {
    return canAct ? (
      <ButtonLink href={statementMappingPath(record.statement_id)} size="xs" variant="outline" leftIcon={<SlidersHorizontal aria-hidden />}>
        Confirm mapping<span className="sr-only">: {name}</span>
      </ButtonLink>
    ) : (
      <span className="text-xs text-fg-subtle">A manager must confirm the column mapping</span>
    );
  }
  if (canAct && canRetryStatementState(record.state)) {
    return (
      <Button size="xs" variant="outline" leftIcon={<RotateCcw aria-hidden />} disabled={retrying} onClick={onRetry}>
        Retry<span className="sr-only">: {name}</span>
      </Button>
    );
  }
  return null;
}

/**
 * Automation's processing state per royalty statement. Every member can see
 * it; managers and above can retry statements automation stopped on.
 */
export function StatementsPanel({ orgId, canAct }: { orgId: string; canAct: boolean }) {
  const [filter, setFilter] = useState<StateFilter>("attention");
  const attention = useStatementsNeedingAttention(orgId, { enabled: filter === "attention" });
  const single = useAutomationStatements(orgId, { state: filter === "attention" ? undefined : filter, limit: 100 }, { enabled: filter !== "attention" });
  const list = filter === "attention" ? attention : single;
  const retry = useRetryAutomationStatement(orgId);
  const [retrying, setRetrying] = useState<StatementAutomationRecord | null>(null);

  const columns: DataTableColumn<StatementAutomationRecord>[] = [
    {
      id: "statement",
      header: "Statement",
      cell: (record) => (
        <div className="min-w-0">
          <Link href={statementPath(record.statement_id)} className="block truncate font-medium text-fg hover:text-primary hover:underline">
            {statementName(record)}
          </Link>
          <p className="truncate text-2xs text-fg-subtle">{record.source === "inbox" ? "From the n8n inbox" : "Uploaded in the app"}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (record) => (
        <Badge tone={statementStateTone(record.state)} dot>
          {statementStateLabel(record.state)}
        </Badge>
      ),
    },
    {
      id: "attempts",
      header: "Attempts",
      align: "right",
      cell: (record) => (
        <span className="tabular-nums">
          {record.attempts} / {record.max_attempts}
        </span>
      ),
    },
    { id: "next_attempt", header: "Next attempt", hideOnMobile: true, cell: (record) => <When value={record.next_attempt_at} /> },
    {
      id: "error",
      header: "Error",
      cell: (record) => {
        const category = errorCategoryLabel(record.error_category);
        if (!category && !record.last_error) return <span className="text-fg-subtle">—</span>;
        return (
          <div className="max-w-xs space-y-0.5">
            {category ? <p className="text-xs font-medium text-fg">{category}</p> : null}
            {record.last_error ? (
              <p className="line-clamp-2 text-xs text-danger" title={record.last_error}>
                {record.last_error}
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "action",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (record) => (
        <StatementAction record={record} canAct={canAct} retrying={retry.isPending && retrying?.statement_id === record.statement_id} onRetry={() => setRetrying(record)} />
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Statements needing attention"
        description="Statements automation is still working on or has stopped on. Failed imports are retried a few times, then wait for a person."
      />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <Select
          size="sm"
          className="sm:w-56"
          aria-label="Filter statements by state"
          value={filter}
          onValueChange={setFilter}
          options={[{ value: "attention", label: "Needs attention" }, ...STATEMENT_AUTOMATION_STATES.map((value) => ({ value, label: statementStateLabel(value) }))]}
        />
      </div>
      <DataTable
        columns={columns}
        data={list.data}
        getRowId={(record) => record.statement_id}
        getRowLabel={statementName}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.data ? null : list.error}
        onRetry={() => void list.refetch()}
        caption="Statement processing by automation"
        emptyState={
          <EmptyState
            compact
            icon={<FileCheck2 aria-hidden />}
            title={filter === "attention" ? "No statements need attention" : `No statements in “${statementStateLabel(filter)}”`}
            description={filter === "attention" ? "Statements show up here while automation processes them or when a person needs to step in." : undefined}
          />
        }
      />
      {canAct ? (
        <ConfirmDialog
          open={retrying !== null}
          onOpenChange={(open) => {
            if (!open) setRetrying(null);
          }}
          tone="primary"
          title="Retry statement processing?"
          description={
            retrying
              ? `“${statementName(retrying)}” is processed again now with its current column mapping, and automation's attempt counter is reset. Nothing is imported twice.`
              : undefined
          }
          confirmLabel="Retry now"
          onConfirm={async () => {
            if (!retrying) return;
            await retry.mutateAsync(retrying.statement_id);
            toast.success("Statement queued for processing");
          }}
        />
      ) : null}
    </Card>
  );
}
