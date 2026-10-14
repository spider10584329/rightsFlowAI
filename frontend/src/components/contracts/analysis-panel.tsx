"use client";

import { Bot, CheckCircle2, ClipboardCheck, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";

import { AiAdvisoryLabel, AiErrorAlert } from "@/components/rights/ai-notice";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import {
  isAnalysisInFlight,
  useContractAnalyses,
  useContractDocuments,
  useRequestAnalysis,
  useReviewAnalysis,
  type ContractAnalysis,
  type ContractDetail,
} from "@/lib/api/hooks/contracts";
import { cn, formatDateTime, titleCase } from "@/lib/utils";

import { ClauseFlagList, type ClauseFlagLike } from "./clause-flags";
import {
  analysisStatusTone,
  APPLICABLE_FIELDS,
  buildReviewPayload,
  candidateValue,
  currentValue,
  differsFromCurrent,
  displayValue,
  FIELD_LABELS,
  hasCandidate,
  reviewStatusTone,
  selectableFields,
  type ApplicableField,
} from "./contract-format";

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued — waiting for a worker",
  running: "Running — reading the document",
  completed: "Completed",
  failed: "Failed",
};

export function AnalysisPanel({ orgId, contract, canEdit, focusId }: { orgId: string; contract: ContractDetail; canEdit: boolean; focusId: string | null }) {
  const analyses = useContractAnalyses(orgId, contract.id);
  const documents = useContractDocuments(orgId, contract.id);
  const request = useRequestAnalysis(orgId, contract.id);
  const extractable = (documents.data ?? []).filter((doc) => doc.text_extractable);
  const [documentId, setDocumentId] = useState("");
  const selectedDoc = documentId || extractable[0]?.id || "";
  const [reviewing, setReviewing] = useState<ContractAnalysis | null>(null);
  const docName = (id: string | null | undefined) => {
    const doc = documents.data?.find((item) => item.id === id);
    return doc ? (doc.label ?? doc.filename) : "Deleted document";
  };

  return (
    <div className="space-y-5">
      <Alert tone="info" title="AI-assisted analysis is advisory">
        AI-generated · advisory — verify before relying on it. Not legal advice. Extracted values are only candidates: nothing changes on the contract unless
        you review the analysis and tick the fields to apply. The rule-based clause scan on the Documents tab works without AI.
      </Alert>

      {canEdit ? (
        <Card>
          <CardHeader title="Request an analysis" description="The AI reads one document and proposes key terms and flagged clauses for review." />
          <CardBody className="space-y-3">
            {documents.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : extractable.length === 0 ? (
              <p className="text-[13px] text-fg-muted">Upload a PDF, DOCX or TXT document first (images cannot be analyzed).</p>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <FormField label="Document" className="sm:flex-1">
                  <NativeSelect value={selectedDoc} onChange={(event) => setDocumentId(event.target.value)}>
                    {extractable.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.label ?? doc.filename}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <Button
                  leftIcon={<Sparkles aria-hidden />}
                  loading={request.isPending}
                  disabled={!selectedDoc}
                  onClick={() =>
                    request.mutate(selectedDoc, {
                      onSuccess: () => toast.success("Analysis queued", { description: "Results appear here when ready. You'll also get a notification." }),
                    })
                  }
                >
                  Analyze with AI
                </Button>
              </div>
            )}
            {request.error ? (
              isApiError(request.error) && request.error.code === "analysis_in_progress" ? (
                <Alert tone="info">{request.error.message}. Its status updates below automatically.</Alert>
              ) : (
                <AiErrorAlert error={request.error} fallbackHint="The rule-based clause scan on the Documents tab is still available." />
              )
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {analyses.isLoading ? (
        <Card className="p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-4 h-32 w-full" />
        </Card>
      ) : analyses.error ? (
        <Card>
          <ErrorState error={analyses.error} onRetry={() => void analyses.refetch()} />
        </Card>
      ) : (analyses.data ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={<Bot aria-hidden />} title="No analyses yet" description={canEdit ? "Request an analysis of an uploaded document above." : "A manager can request an AI analysis of the contract documents."} />
        </Card>
      ) : (
        <div className="space-y-5">
          {(analyses.data ?? []).map((analysis) => (
            <AnalysisCard
              key={analysis.id}
              analysis={analysis}
              contract={contract}
              documentName={docName(analysis.document_id)}
              focused={analysis.id === focusId}
              canEdit={canEdit}
              onReview={() => setReviewing(analysis)}
            />
          ))}
        </div>
      )}

      {reviewing ? <ReviewDialog key={reviewing.id} orgId={orgId} contract={contract} analysis={reviewing} onClose={() => setReviewing(null)} /> : null}
    </div>
  );
}

function AnalysisCard({
  analysis,
  contract,
  documentName,
  focused,
  canEdit,
  onReview,
}: {
  analysis: ContractAnalysis;
  contract: ContractDetail;
  documentName: string;
  focused: boolean;
  canEdit: boolean;
  onReview: () => void;
}) {
  const extracted = analysis.extracted ?? null;
  const injection = Boolean(extracted?.prompt_injection_suspected) || (analysis.flagged_clauses ?? []).some((flag) => flag.category === "prompt_injection_suspected");
  const inFlight = isAnalysisInFlight(analysis);
  const flags = (analysis.flagged_clauses ?? []).filter((flag) => flag.category !== "prompt_injection_suspected") as ClauseFlagLike[];
  const parties = Array.isArray(extracted?.parties) ? (extracted.parties as { name?: string; role?: string | null }[]) : [];
  const rates = Array.isArray(extracted?.royalty_rates) ? (extracted.royalty_rates as { description?: string; rate_percent?: string | null; basis?: string | null }[]) : [];

  return (
    <Card id={`analysis-${analysis.id}`} className={cn(focused && "ring-2 ring-primary/40")}>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-accent" aria-hidden /> Analysis of {documentName}
          </span>
        }
        description={`Requested ${formatDateTime(analysis.created_at)}${analysis.model ? ` · ${[analysis.provider, analysis.model].filter(Boolean).join(" / ")}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={analysisStatusTone(analysis.status)} dot>
              {inFlight ? <Spinner size="xs" /> : null}
              {titleCase(analysis.status)}
            </Badge>
            {analysis.status === "completed" ? (
              <Badge tone={reviewStatusTone(analysis.review_status)}>{analysis.review_status === "pending_review" ? "Needs review" : titleCase(analysis.review_status)}</Badge>
            ) : null}
            {canEdit && analysis.status === "completed" && analysis.review_status === "pending_review" ? (
              <Button size="sm" leftIcon={<ClipboardCheck aria-hidden />} onClick={onReview}>
                Review
              </Button>
            ) : null}
          </div>
        }
      />
      <CardBody className="space-y-5">
        <AiAdvisoryLabel notice={analysis.advisory_notice} />
        {inFlight ? (
          <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
            <Spinner size="sm" /> {STATUS_TEXT[analysis.status]}. This page checks for results every few seconds.
          </p>
        ) : null}
        {analysis.status === "failed" ? (
          <Alert tone="danger" title="Analysis failed">
            {analysis.error ?? "The AI provider could not analyze this document."} You can request a new analysis, or use the rule-based clause scan.
          </Alert>
        ) : null}
        {injection ? (
          <Alert tone="danger" title="Possible prompt injection in the document" assertive>
            The document appears to contain text that tries to instruct the AI. Treat every extracted value with suspicion and check the source document manually.
          </Alert>
        ) : null}

        {analysis.status === "completed" && extracted ? (
          <>
            <section aria-label="Extracted fields compared with current values">
              <h3 className="mb-2 text-[13px] font-semibold">Extracted vs. current</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <thead className="bg-surface-2/60 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">Field</th>
                      <th scope="col" className="px-3 py-2 font-medium">AI suggestion</th>
                      <th scope="col" className="px-3 py-2 font-medium">Current contract</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {APPLICABLE_FIELDS.map((field) => {
                      const candidate = candidateValue(field, extracted);
                      const differs = hasCandidate(field, extracted) && differsFromCurrent(field, extracted, contract);
                      return (
                        <tr key={field} className={cn(differs && "bg-warning-soft/30")}>
                          <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                            {FIELD_LABELS[field]}
                            {differs ? <span className="ml-1.5 text-2xs font-normal text-warning-soft-fg">differs</span> : null}
                          </th>
                          <td className="max-w-xs px-3 py-2">
                            <span className="line-clamp-3">{displayValue(candidate)}</span>
                          </td>
                          <td className="max-w-xs px-3 py-2 text-fg-muted">
                            <span className="line-clamp-3">{displayValue(currentValue(field, contract))}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="grid gap-5 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-[13px] font-semibold">Parties mentioned</h3>
                {parties.length === 0 ? (
                  <p className="text-[13px] text-fg-subtle">None extracted.</p>
                ) : (
                  <ul className="space-y-1 text-[13px]">
                    {parties.map((party, index) => (
                      <li key={index}>
                        <span className="font-medium">{party.name}</span>
                        {party.role ? <span className="text-fg-muted"> · {party.role}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="mb-2 text-[13px] font-semibold">Royalty rates mentioned</h3>
                {rates.length === 0 ? (
                  <p className="text-[13px] text-fg-subtle">None extracted.</p>
                ) : (
                  <ul className="space-y-1 text-[13px]">
                    {rates.map((rate, index) => (
                      <li key={index}>
                        {rate.description}
                        {rate.rate_percent ? <span className="font-medium tabular-nums"> · {rate.rate_percent}%</span> : null}
                        {rate.basis ? <span className="text-fg-muted"> ({rate.basis})</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-fg-subtle">Parties and rates are not applied automatically — add them in the contract form if correct.</p>
              </section>
            </div>
            {typeof extracted.renewal_terms === "string" && extracted.renewal_terms ? (
              <p className="text-[13px]">
                <span className="font-medium">Renewal terms: </span>
                {extracted.renewal_terms}
              </p>
            ) : null}
            {typeof extracted.confidence_notes === "string" && extracted.confidence_notes ? (
              <p className="text-xs text-fg-muted">
                <span className="font-medium">Model confidence notes: </span>
                {extracted.confidence_notes}
              </p>
            ) : null}
          </>
        ) : null}

        {analysis.status === "completed" ? (
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
              <ShieldAlert className="size-4 text-fg-subtle" aria-hidden /> Flagged clauses ({flags.length})
            </h3>
            <ClauseFlagList flags={flags} />
          </section>
        ) : null}

        {analysis.review_status !== "pending_review" ? (
          <p className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-fg-muted">
            {analysis.review_status === "accepted" ? <CheckCircle2 className="size-3.5 text-success" aria-hidden /> : <XCircle className="size-3.5 text-danger" aria-hidden />}
            {titleCase(analysis.review_status)} {formatDateTime(analysis.reviewed_at)}
            {analysis.review_notes ? ` — “${analysis.review_notes}”` : ""}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ReviewDialog({ orgId, contract, analysis, onClose }: { orgId: string; contract: ContractDetail; analysis: ContractAnalysis; onClose: () => void }) {
  const review = useReviewAnalysis(orgId, contract.id);
  const extracted = analysis.extracted ?? null;
  // Pre-select nothing: the reviewer must tick each field deliberately.
  const [selected, setSelected] = useState<Set<ApplicableField>>(new Set());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<Record<string, string>>({});
  const suggested = selectableFields(extracted, contract);

  const submit = (decision: "accepted" | "rejected") => {
    setError(null);
    setFieldProblems({});
    review.mutate(
      { analysisId: analysis.id, body: buildReviewPayload(decision, selected, notes) },
      {
        onSuccess: () => {
          toast.success(decision === "accepted" ? (selected.size ? `Analysis accepted · ${selected.size} field(s) applied` : "Analysis accepted") : "Analysis rejected");
          onClose();
        },
        onError: (cause) => {
          if (isApiError(cause) && cause.code === "invalid_ai_fields" && cause.details && typeof cause.details === "object" && !Array.isArray(cause.details)) {
            setFieldProblems(cause.details as Record<string, string>);
          }
          setError(errorMessage(cause));
        },
      },
    );
  };

  const toggle = (field: ApplicableField, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(field);
      else next.delete(field);
      return next;
    });

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && !review.isPending && onClose()}
      title="Review AI analysis"
      description="Tick only the values you have checked against the document. Unticked values are ignored. Accepting or rejecting is recorded in the activity log."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={review.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => submit("rejected")} disabled={review.isPending || selected.size > 0} title={selected.size > 0 ? "Untick fields to reject" : undefined}>
            Reject
          </Button>
          <Button onClick={() => submit("accepted")} loading={review.isPending} leftIcon={<CheckCircle2 aria-hidden />}>
            {selected.size > 0 ? `Accept & apply ${selected.size} field${selected.size === 1 ? "" : "s"}` : "Accept without changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <AiAdvisoryLabel notice={analysis.advisory_notice} />
        {error ? (
          <Alert tone="danger" assertive>
            {error}
          </Alert>
        ) : null}
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Fields to apply ({suggested.length} differ from the contract)</legend>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {APPLICABLE_FIELDS.map((field) => {
              const available = hasCandidate(field, extracted);
              const differs = available && differsFromCurrent(field, extracted, contract);
              const id = `apply-${field}`;
              return (
                <li key={field} className={cn("grid gap-2 px-3 py-2.5 text-[13px] sm:grid-cols-[12rem_1fr_1fr]", !available && "opacity-60")}>
                  <div className="flex items-center gap-2">
                    <Checkbox id={id} disabled={!available} checked={selected.has(field)} onCheckedChange={(checked) => toggle(field, checked === true)} />
                    <label htmlFor={id} className="font-medium">
                      {FIELD_LABELS[field]}
                    </label>
                  </div>
                  <div className="min-w-0">
                    <span className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">AI</span>
                    <p className="line-clamp-3 break-words">{available ? displayValue(candidateValue(field, extracted)) : "No value extracted"}</p>
                    {fieldProblems[field] ? <p className="text-xs font-medium text-danger">{fieldProblems[field]}</p> : null}
                  </div>
                  <div className="min-w-0">
                    <span className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Current</span>
                    <p className={cn("line-clamp-3 break-words text-fg-muted", differs && "text-warning-soft-fg")}>{displayValue(currentValue(field, contract))}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <FormField label="Review notes" hint="Optional. Saved with the decision.">
          <Textarea rows={2} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
