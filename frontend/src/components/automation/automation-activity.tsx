"use client";

import { AlertOctagon, ChevronDown, ChevronRight, ClipboardList, History, Inbox, KeyRound, RotateCcw, Siren, Workflow } from "lucide-react";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import {
  EVENT_STATUSES,
  RUN_STATUSES,
  useAutomationEvents,
  useAutomationOverview,
  useAutomationRuns,
  useRequeueAutomationEvent,
  type AutomationEvent,
  type AutomationEventStatus,
  type AutomationRun,
  type AutomationRunStatus,
} from "@/lib/api/hooks/automation";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { eventStatusTone, formatAge, prettyJson, runStatusTone, triggerLabel } from "./automation-format";

/** Relative time with the full timestamp on hover; a dash when empty. */
export function When({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-fg-subtle">—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="whitespace-nowrap text-fg-muted">
      {formatRelative(value)}
    </time>
  );
}

// ----------------------------------------------------------------- overview

export function AutomationOverviewCards({ orgId }: { orgId: string }) {
  const overview = useAutomationOverview(orgId);
  if (overview.error && !overview.data) {
    return (
      <Card className="mb-6">
        <ErrorState error={overview.error} title="Couldn't load automation health" compact onRetry={() => void overview.refetch()} retrying={overview.isFetching} />
      </Card>
    );
  }
  const data = overview.data;
  const loading = overview.isLoading;
  const expiring = data?.expiring_credentials ?? 0;
  return (
    <>
      {data?.automation_enabled === false ? (
        <Alert tone="warning" title="Event delivery is off" className="mb-4">
          No unrevoked key has the <span className="font-mono">events:consume</span> scope, so uploads and other changes are not queued for n8n.
          Create a key with that scope to turn it on.
        </Alert>
      ) : null}
      <section aria-label="Automation health" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Active keys"
          value={data?.active_credentials ?? 0}
          icon={<KeyRound aria-hidden />}
          loading={loading}
          hint={
            data ? (
              <>
                {expiring > 0 ? `${expiring.toLocaleString()} expiring soon` : "None expiring soon"}
                {data.automation_enabled !== undefined ? ` · Event delivery ${data.automation_enabled ? "on" : "off"}` : null}
              </>
            ) : undefined
          }
        />
        <StatCard
          label="Pending events"
          value={data ? data.outbox.pending + data.outbox.claimed : 0}
          icon={<Inbox aria-hidden />}
          loading={loading}
          hint={data ? (data.outbox.oldest_pending_seconds !== null ? `Oldest waiting ${formatAge(data.outbox.oldest_pending_seconds)}` : "Queue is empty") : undefined}
        />
        <StatCard
          label="Dead events"
          value={data?.outbox.dead ?? 0}
          icon={<AlertOctagon aria-hidden />}
          loading={loading}
          hint={data ? (data.outbox.dead > 0 ? "Needs requeue or investigation" : `${data.outbox.completed.toLocaleString()} completed`) : undefined}
        />
        <StatCard label="Failed runs (24h)" value={data?.failed_runs_24h ?? 0} icon={<History aria-hidden />} loading={loading} />
        <StatCard label="Open incidents" value={data?.open_incidents ?? 0} icon={<Siren aria-hidden />} loading={loading} />
        <StatCard label="Open review tasks" value={data?.open_review_tasks ?? 0} icon={<ClipboardList aria-hidden />} loading={loading} />
      </section>
    </>
  );
}

// ----------------------------------------------------------------- runs

export function RunsPanel({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<AutomationRunStatus | "all">("all");
  const runs = useAutomationRuns(orgId, { status: status === "all" ? undefined : status, limit: 50 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: DataTableColumn<AutomationRun>[] = [
    {
      id: "workflow",
      header: "Workflow",
      cell: (run) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{run.workflow}</p>
          {run.execution_id ? <p className="truncate font-mono text-2xs text-fg-subtle">Execution {run.execution_id}</p> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (run) => (
        <Badge tone={runStatusTone(run.status)} dot>
          {titleCase(run.status)}
        </Badge>
      ),
    },
    { id: "trigger", header: "Trigger", hideOnMobile: true, cell: (run) => <span className="whitespace-nowrap text-fg-muted">{triggerLabel(run.trigger_type)}</span> },
    { id: "started", header: "Started", cell: (run) => <When value={run.started_at} /> },
    { id: "finished", header: "Finished", hideOnMobile: true, cell: (run) => <When value={run.finished_at} /> },
    { id: "retries", header: "Retries", align: "right", hideOnMobile: true, cell: (run) => <span className="tabular-nums">{run.retry_count}</span> },
    {
      id: "error",
      header: "Error",
      cell: (run) =>
        run.error_code || run.error_message ? (
          <span className="line-clamp-2 max-w-xs text-xs text-danger" title={run.error_message ?? undefined}>
            {run.error_code ? <span className="font-mono">{run.error_code}</span> : null}
            {run.error_code && run.error_message ? ": " : null}
            {run.error_message}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "summary",
      header: <span className="sr-only">Summary</span>,
      cell: (run) =>
        run.summary ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded.has(run.id)}
            aria-controls={`run-summary-${run.id}`}
            leftIcon={expanded.has(run.id) ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            onClick={() => toggle(run.id)}
          >
            Summary<span className="sr-only"> for {run.workflow}</span>
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader title="Recent runs" description="The latest 50 workflow runs reported by n8n." />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <Select
          size="sm"
          className="sm:w-44"
          aria-label="Filter runs by status"
          value={status}
          onValueChange={setStatus}
          options={[{ value: "all", label: "All statuses" }, ...RUN_STATUSES.map((value) => ({ value, label: titleCase(value) }))]}
        />
      </div>
      <DataTable
        columns={columns}
        data={runs.data}
        getRowId={(run) => run.id}
        getRowLabel={(run) => `${run.workflow} ${formatDateTime(run.started_at)}`}
        isLoading={runs.isLoading}
        isFetching={runs.isFetching}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        caption="Recent automation runs"
        renderExpanded={(run) =>
          run.summary && expanded.has(run.id) ? (
            <pre
              id={`run-summary-${run.id}`}
              tabIndex={0}
              aria-label={`Summary for ${run.workflow}`}
              className="scrollbar-thin max-h-72 overflow-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              {prettyJson(run.summary)}
            </pre>
          ) : null
        }
        emptyState={
          <EmptyState
            compact
            icon={<Workflow aria-hidden />}
            title={status === "all" ? "No runs recorded yet" : "No runs with this status"}
            description="Runs appear once n8n workflows start reporting with an automation key."
          />
        }
      />
    </Card>
  );
}

// ----------------------------------------------------------------- outbox

export function EventsPanel({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<AutomationEventStatus | "all">("all");
  const events = useAutomationEvents(orgId, { status: status === "all" ? undefined : status, limit: 50 });
  const requeue = useRequeueAutomationEvent(orgId);

  const doRequeue = (event: AutomationEvent) =>
    requeue.mutate(event.id, {
      onSuccess: () => toast.success("Event requeued", { description: `${event.event_type} will be delivered again.` }),
      onError: (error) => toast.error("Couldn't requeue event", { description: errorMessage(error) }),
    });

  const columns: DataTableColumn<AutomationEvent>[] = [
    {
      id: "event_type",
      header: "Event",
      cell: (event) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium">{event.event_type}</p>
          <p className="truncate font-mono text-2xs text-fg-subtle">{event.id.slice(0, 8)}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (event) => (
        <Badge tone={eventStatusTone(event.status)} dot>
          {titleCase(event.status)}
        </Badge>
      ),
    },
    {
      id: "attempts",
      header: "Attempts",
      align: "right",
      cell: (event) => (
        <span className="tabular-nums">
          {event.attempts} / {event.max_attempts}
        </span>
      ),
    },
    { id: "created", header: "Created", cell: (event) => <When value={event.created_at} /> },
    { id: "completed", header: "Completed", hideOnMobile: true, cell: (event) => <When value={event.completed_at} /> },
    {
      id: "error",
      header: "Last error",
      hideOnMobile: true,
      cell: (event) =>
        event.last_error ? (
          <span className="line-clamp-2 max-w-xs text-xs text-danger" title={event.last_error}>
            {event.last_error}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
  ];

  const rowActions = (event: AutomationEvent): RowAction[] =>
    event.status === "dead" ? [{ label: "Requeue event", icon: <RotateCcw aria-hidden />, disabled: requeue.isPending, onSelect: () => doRequeue(event) }] : [];

  return (
    <Card>
      <CardHeader title="Outbox events" description="Events waiting for, or already delivered to, n8n. Dead events ran out of attempts and can be requeued." />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <Select
          size="sm"
          className="sm:w-44"
          aria-label="Filter events by status"
          value={status}
          onValueChange={setStatus}
          options={[{ value: "all", label: "All statuses" }, ...EVENT_STATUSES.map((value) => ({ value, label: titleCase(value) }))]}
        />
      </div>
      <DataTable
        columns={columns}
        data={events.data}
        getRowId={(event) => event.id}
        getRowLabel={(event) => `${event.event_type} ${event.id.slice(0, 8)}`}
        isLoading={events.isLoading}
        isFetching={events.isFetching}
        error={events.error}
        onRetry={() => void events.refetch()}
        rowActions={rowActions}
        caption="Automation outbox events"
        emptyState={
          <EmptyState
            compact
            icon={<Inbox aria-hidden />}
            title={status === "all" ? "The outbox is empty" : `No ${status} events`}
            description="Events are queued when statements are uploaded, catalog items are created, conflicts open or a review is requested."
          />
        }
      />
    </Card>
  );
}
