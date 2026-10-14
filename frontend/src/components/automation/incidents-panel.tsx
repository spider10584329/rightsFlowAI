"use client";

import { CheckCircle2, ShieldCheck, Siren } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { useAutomationIncidents, useResolveAutomationIncident, type AutomationIncident, type IncidentStatus } from "@/lib/api/hooks/automation";
import { formatDateTime } from "@/lib/utils";

import { When } from "./automation-activity";
import { incidentCategoryLabel } from "./automation-format";

const STATUS_OPTIONS: { value: IncidentStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

/**
 * Workflow failures grouped into incidents (one per workflow and cause).
 * Repeated failures raise the occurrence count; alerts are rate-limited and the rest counted as suppressed.
 */
export function IncidentsPanel({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<IncidentStatus>("open");
  const incidents = useAutomationIncidents(orgId, { status, limit: 100 });
  const resolve = useResolveAutomationIncident(orgId);
  const [resolving, setResolving] = useState<AutomationIncident | null>(null);
  const [note, setNote] = useState("");

  const columns: DataTableColumn<AutomationIncident>[] = [
    {
      id: "title",
      header: "Incident",
      cell: (incident) => (
        <div className="min-w-0 max-w-md space-y-0.5">
          <p className="flex flex-wrap items-center gap-1.5 font-medium">
            {incident.title}
            {incident.escalated_at ? (
              <Badge tone="danger" title={`Escalated ${formatDateTime(incident.escalated_at)}`}>
                Escalated
              </Badge>
            ) : null}
          </p>
          {incident.resource ? <p className="truncate font-mono text-2xs text-fg-subtle">{incident.resource}</p> : null}
          {incident.last_error ? (
            <p className="line-clamp-2 text-xs text-danger" title={incident.last_error}>
              {incident.last_error}
            </p>
          ) : null}
          {incident.status === "resolved" ? (
            <p className="text-xs text-fg-muted">
              Resolved {formatDateTime(incident.resolved_at)}
              {incident.resolution ? <span className="text-fg-subtle"> · {incident.resolution}</span> : null}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: "workflow",
      header: "Workflow",
      cell: (incident) => (
        <div className="min-w-0">
          <p className="truncate">{incident.workflow}</p>
          {incident.last_execution_id ? <p className="truncate font-mono text-2xs text-fg-subtle">Execution {incident.last_execution_id}</p> : null}
        </div>
      ),
    },
    { id: "category", header: "Category", hideOnMobile: true, cell: (incident) => <Badge>{incidentCategoryLabel(incident.category)}</Badge> },
    { id: "occurrences", header: "Occurrences", align: "right", cell: (incident) => <span className="tabular-nums">{incident.occurrences.toLocaleString()}</span> },
    {
      id: "alerts",
      header: "Alerts sent",
      align: "right",
      hideOnMobile: true,
      cell: (incident) => <span className="tabular-nums">{incident.alerts_sent.toLocaleString()}</span>,
    },
    {
      id: "suppressed",
      header: "Suppressed",
      align: "right",
      hideOnMobile: true,
      cell: (incident) => <span className="tabular-nums text-fg-muted">{incident.suppressed.toLocaleString()}</span>,
    },
    { id: "last_seen", header: "Last seen", cell: (incident) => <When value={incident.last_seen_at} /> },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (incident) =>
        incident.status === "open" ? (
          <Button size="xs" variant="outline" leftIcon={<CheckCircle2 aria-hidden />} onClick={() => setResolving(incident)}>
            Mark resolved<span className="sr-only">: {incident.title}</span>
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Incidents"
        description="Repeated workflow failures grouped by workflow and cause. Alerts are rate-limited; further failures are counted as suppressed."
      />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <SegmentedControl aria-label="Show incidents" value={status} onValueChange={setStatus} options={STATUS_OPTIONS} />
      </div>
      <DataTable
        columns={columns}
        data={incidents.data}
        getRowId={(incident) => incident.id}
        getRowLabel={(incident) => incident.title}
        isLoading={incidents.isLoading}
        isFetching={incidents.isFetching}
        error={incidents.error}
        onRetry={() => void incidents.refetch()}
        caption={status === "open" ? "Open automation incidents" : "Resolved automation incidents"}
        emptyState={
          <EmptyState
            compact
            icon={status === "open" ? <ShieldCheck aria-hidden /> : <Siren aria-hidden />}
            title={status === "open" ? "No open incidents" : "No resolved incidents"}
            description={status === "open" ? "Workflow failures reported by n8n open an incident here." : undefined}
          />
        }
      />
      <ConfirmDialog
        open={resolving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResolving(null);
            setNote("");
          }
        }}
        tone="primary"
        title="Mark incident resolved?"
        description={resolving ? `“${resolving.title}”. If the workflow fails again, a new incident opens.` : undefined}
        confirmLabel="Mark resolved"
        onConfirm={async () => {
          if (!resolving) return;
          await resolve.mutateAsync({ incidentId: resolving.id, note });
          toast.success("Incident resolved");
        }}
      >
        <FormField label="Note" hint="Optional. For example why the failure no longer matters.">
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} rows={2} />
        </FormField>
      </ConfirmDialog>
    </Card>
  );
}
