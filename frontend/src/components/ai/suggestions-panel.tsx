"use client";

import { Check, Inbox, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { AdvisoryLabel, AiErrorAlert, EntityBadge, RecordLink } from "@/components/ai/ai-ui";
import { GenerateSuggestionsDialog } from "@/components/ai/generate-dialog";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useApproveSuggestion, useRejectSuggestion, useSuggestions, type AISuggestion, type SuggestionStatus } from "@/lib/api/hooks/ai";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { cn, formatDateTime, titleCase } from "@/lib/utils";

const STATUS_FILTERS: { value: SuggestionStatus | "all"; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "applied", label: "Applied" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  hasFrom: boolean;
}

/** `{field: {from, to}}` -> rows; malformed entries are shown raw. */
export function changeRows(changes: Record<string, unknown>): FieldChange[] {
  return Object.entries(changes ?? {}).map(([field, change]) => {
    if (change && typeof change === "object" && !Array.isArray(change) && "to" in change) {
      const record = change as { from?: unknown; to: unknown };
      return { field, from: record.from, to: record.to, hasFrom: "from" in record };
    }
    return { field, from: undefined, to: change, hasFrom: false };
  });
}

function DiffTable({ changes }: { changes: Record<string, unknown> }) {
  const rows = changeRows(changes);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <caption className="sr-only">Proposed field changes</caption>
        <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">Field</th>
            <th scope="col" className="px-3 py-2 font-semibold">Current</th>
            <th scope="col" className="px-3 py-2 font-semibold">Proposed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.field} className="align-top">
              <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium text-fg">{titleCase(row.field)}</th>
              <td className="px-3 py-2">
                <span className="sr-only">From: </span>
                <span className="break-all rounded bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger-soft-fg line-through decoration-danger/40">
                  {row.hasFrom ? display(row.from) : "—"}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className="sr-only">To: </span>
                <span className="break-all rounded bg-success-soft px-1.5 py-0.5 font-mono text-xs text-success-soft-fg">{display(row.to)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SuggestionsPanel({ orgId, canReview, configured }: { orgId: string; canReview: boolean; configured: boolean }) {
  const table = useTableQueryState<"status">({ defaultPageSize: 10, filterKeys: ["status"] });
  const statusFilter = (table.filters.status || "pending") as SuggestionStatus | "all";
  const suggestions = useSuggestions(orgId, {
    page: table.page,
    page_size: table.pageSize,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const approve = useApproveSuggestion(orgId);
  const [rejecting, setRejecting] = useState<AISuggestion | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const doApprove = (suggestion: AISuggestion) => {
    setBusyId(suggestion.id);
    approve.mutate(suggestion.id, {
      onSuccess: (result) => {
        const applied = Object.keys(result.applied_changes).length;
        toast.success(`Applied ${applied} change${applied === 1 ? "" : "s"}`, {
          description: result.skipped.length ? `${result.skipped.length} skipped: ${result.skipped.map((s) => `${s.field} (${s.reason})`).join("; ")}` : undefined,
        });
      },
      onError: (error) => {
        const details = isApiError(error) && error.details && typeof error.details === "object" ? (error.details as { skipped?: { field: string; reason: string }[] }).skipped : undefined;
        toast.error("Suggestion not applied", {
          description: details?.length ? `${errorMessage(error)} — ${details.map((s) => `${s.field}: ${s.reason}`).join("; ")}` : errorMessage(error),
        });
      },
      onSettled: () => setBusyId(null),
    });
  };

  const data = suggestions.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center md:justify-between">
          <div role="group" aria-label="Filter suggestions by status" className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={statusFilter === option.value}
                onClick={() => table.setFilter("status", option.value === "pending" ? null : option.value)}
                className={cn(
                  "h-8 rounded-md px-3 text-[13px] font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring",
                  statusFilter === option.value && "bg-primary-soft text-primary-soft-fg",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {canReview ? (
            <Button size="sm" leftIcon={<Sparkles aria-hidden />} onClick={() => setGenerateOpen(true)} disabled={!configured} title={configured ? undefined : "AI provider not configured"}>
              Generate suggestions
            </Button>
          ) : null}
        </div>

        <div className={cn("divide-y divide-border", suggestions.isFetching && !suggestions.isLoading && "opacity-70")} aria-busy={suggestions.isFetching || undefined}>
          {suggestions.isLoading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-24 w-full" />
              ))}
            </div>
          ) : suggestions.error ? (
            <ErrorState error={suggestions.error} onRetry={() => void suggestions.refetch()} compact />
          ) : !data || data.items.length === 0 ? (
            <EmptyState
              compact
              icon={<Inbox aria-hidden />}
              title={statusFilter === "pending" ? "No suggestions waiting for review" : "No suggestions"}
              description={
                canReview
                  ? configured
                    ? "Generate metadata cleanup suggestions for a work, recording or party. Nothing changes until someone approves."
                    : "Suggestions appear here once an AI provider is configured and suggestions are generated."
                  : "Suggestions generated by managers appear here."
              }
              action={
                canReview && configured ? (
                  <Button size="sm" variant="outline" onClick={() => setGenerateOpen(true)}>
                    Generate suggestions
                  </Button>
                ) : null
              }
            />
          ) : (
            data.items.map((suggestion) => (
              <article key={suggestion.id} className="space-y-3 px-5 py-4" aria-label={suggestion.title}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={statusTone(suggestion.status === "applied" ? "completed" : suggestion.status)} dot>
                        {titleCase(suggestion.status)}
                      </Badge>
                      <EntityBadge entityType={suggestion.entity_type} />
                      <Badge tone="accent">{suggestion.source === "ai" ? "AI" : titleCase(suggestion.source)}</Badge>
                    </div>
                    <h3 className="text-sm font-semibold text-fg">{suggestion.title}</h3>
                    <p className="text-xs text-fg-subtle">
                      <RecordLink entityType={suggestion.entity_type} id={suggestion.entity_id}>
                        Open {suggestion.entity_type}
                      </RecordLink>{" "}
                      · created {formatDateTime(suggestion.created_at)}
                      {suggestion.reviewed_at ? ` · reviewed ${formatDateTime(suggestion.reviewed_at)}` : ""}
                    </p>
                  </div>
                  {canReview && suggestion.status === "pending" ? (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="outline" leftIcon={<X aria-hidden />} onClick={() => setRejecting(suggestion)} disabled={busyId === suggestion.id}>
                        Reject
                      </Button>
                      <Button size="sm" leftIcon={<Check aria-hidden />} onClick={() => doApprove(suggestion)} loading={busyId === suggestion.id}>
                        Approve &amp; apply
                      </Button>
                    </div>
                  ) : null}
                </div>
                <DiffTable changes={suggestion.proposed_changes} />
                {suggestion.rationale ? (
                  <p className="text-[13px] leading-relaxed text-fg-muted">
                    <span className="font-medium text-fg">Rationale: </span>
                    {suggestion.rationale}
                  </p>
                ) : null}
                {suggestion.source === "ai" ? <AdvisoryLabel /> : null}
              </article>
            ))
          )}
        </div>
        {data && data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} pageSizeOptions={[10, 25, 50]} />
          </div>
        ) : null}
      </Card>

      <RejectDialog orgId={orgId} suggestion={rejecting} onClose={() => setRejecting(null)} />
      {canReview ? <GenerateSuggestionsDialog orgId={orgId} open={generateOpen} onOpenChange={setGenerateOpen} /> : null}
    </div>
  );
}

function RejectDialog({ orgId, suggestion, onClose }: { orgId: string; suggestion: AISuggestion | null; onClose: () => void }) {
  const reject = useRejectSuggestion(orgId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  if ((suggestion?.id ?? null) !== current) {
    setCurrent(suggestion?.id ?? null);
    setReason("");
    setError(null);
  }

  const submit = () => {
    if (!suggestion) return;
    if (reason.length > 500) return setError("Keep the reason under 500 characters.");
    reject.mutate(
      { id: suggestion.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Suggestion rejected");
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <Dialog
      open={suggestion !== null}
      onOpenChange={(open) => !open && !reject.isPending && onClose()}
      title="Reject suggestion?"
      description={suggestion ? `"${suggestion.title}" will be marked rejected. The record is not changed.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={reject.isPending}>
            Reject
          </Button>
        </>
      }
    >
      <FormField label="Reason (optional)" error={error ?? undefined} hint="Recorded in the audit log. Up to 500 characters.">
        <Textarea value={reason} maxLength={500} rows={3} onChange={(event) => setReason(event.target.value)} />
      </FormField>
      {reject.error && !error ? <AiErrorAlert error={reject.error} className="mt-3" /> : null}
    </Dialog>
  );
}
