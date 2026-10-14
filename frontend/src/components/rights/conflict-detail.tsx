"use client";

import { CheckCircle2, Eye, RotateCcw, Sparkles, XCircle, ArrowRight, EyeOff, Clock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { KeyValueList } from "@/components/ui/key-value";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useConflictTransition, useExplainConflict, type ConflictAction, type ConflictExplanation, type RightsConflict } from "@/lib/api/hooks/rights";
import { formatDateTime, titleCase } from "@/lib/utils";

import { AiAdvisoryLabel, AiErrorAlert } from "./ai-notice";
import { ConflictStatusBadge, ConflictTypeBadge, RightsTypeBadge, SeverityBadge } from "./badges";
import { CONFLICT_TYPE_EXPLAINERS, conflictActionNeedsNotes, conflictActionsFor, formatPercent, periodLabel, roleLabel, territoryLabel } from "./rights-format";

interface ShareBrief {
  id: string;
  party_id?: string;
  party_name?: string;
  role?: string;
  share_percent?: string;
  territories?: string[];
  excluded_territories?: string[];
  effective_from?: string | null;
  effective_to?: string | null;
  is_controlled?: boolean;
}

/** Shares referenced by a conflict's details (`shares` list or single `share`). */
export function involvedShares(details: RightsConflict["details"]): ShareBrief[] {
  if (!details) return [];
  const list = Array.isArray(details.shares) ? details.shares : details.share && typeof details.share === "object" ? [details.share] : [];
  return list.filter((item): item is ShareBrief => Boolean(item && typeof item === "object" && "id" in (item as object)));
}

const ACTION_META: Record<ConflictAction, { label: string; icon: typeof Eye; past: string; description: string }> = {
  acknowledge: { label: "Acknowledge", icon: Eye, past: "acknowledged", description: "Confirm someone is looking into this conflict." },
  resolve: { label: "Resolve", icon: CheckCircle2, past: "resolved", description: "Record how the conflict was fixed. Notes are required." },
  dismiss: { label: "Dismiss", icon: XCircle, past: "dismissed", description: "Record why this is not a real problem. Notes are required." },
  reopen: { label: "Reopen", icon: RotateCcw, past: "reopened", description: "Move the conflict back to open for review." },
};

/** `headingLevel` is the level of the section headings: 3 inside a titled sheet, 2 directly under the page `h1`. */
export function ConflictDetail({ orgId, conflict, canEdit, headingLevel = 3 }: { orgId: string; conflict: RightsConflict; canEdit: boolean; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const [action, setAction] = useState<ConflictAction | null>(null);
  const explain = useExplainConflict(orgId);
  const shares = involvedShares(conflict.details);
  const assetType = conflict.asset_type;
  const assetId = conflict.work_id ?? conflict.recording_id;
  const details = conflict.details ?? {};
  const unresolved = conflict.status === "open" || conflict.status === "acknowledged";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={conflict.severity} />
        <ConflictStatusBadge status={conflict.status} />
        <ConflictTypeBadge type={conflict.conflict_type} />
        {conflict.rights_type ? <RightsTypeBadge rightsType={conflict.rights_type} /> : null}
        {conflict.still_detected ? (
          <Badge tone="danger" className="gap-1">
            <Clock className="size-3" aria-hidden /> Still detected
          </Badge>
        ) : (
          <Badge tone="info" className="gap-1">
            <EyeOff className="size-3" aria-hidden /> No longer detected
          </Badge>
        )}
      </div>

      {!conflict.still_detected && unresolved ? (
        <Alert tone="info" title="No longer detected — needs human confirmation">
          The latest scan did not find this problem any more, but conflicts are never closed automatically. Check the ownership and resolve or dismiss it
          with a note.
        </Alert>
      ) : null}

      <section className="space-y-2">
        <Heading className="text-[13px] font-semibold text-fg">What&apos;s wrong</Heading>
        {CONFLICT_TYPE_EXPLAINERS[conflict.conflict_type] ? <p className="text-[13px] text-fg-muted">{CONFLICT_TYPE_EXPLAINERS[conflict.conflict_type]}</p> : null}
        <p className="rounded-lg border border-border bg-surface-2/50 px-3.5 py-3 text-[13px] leading-relaxed text-fg">{conflict.explanation}</p>
      </section>

      <KeyValueList
        items={[
          {
            label: "Asset",
            value:
              assetType && assetId ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                  <Link href={`/rights?asset_type=${assetType}&asset_id=${assetId}`} className="font-medium text-primary hover:underline">
                    Open ownership
                  </Link>
                  <Link href={`/catalog/${assetType === "work" ? "works" : "recordings"}/${assetId}`} className="text-fg-muted hover:text-fg hover:underline">
                    {titleCase(assetType)} in catalog
                  </Link>
                </span>
              ) : (
                "—"
              ),
          },
          ...(typeof details.total === "string"
            ? [{ label: "Total vs expected", value: `${formatPercent(details.total as string)} vs ${formatPercent(details.expected_total as string)} (±${formatPercent(details.tolerance as string)})` }]
            : []),
          ...(typeof details.combined_percent === "string" ? [{ label: "Combined claim", value: formatPercent(details.combined_percent as string) }] : []),
          ...(Array.isArray(details.territories)
            ? [{ label: "Territories", value: territoryLabel(details.territories as string[], details.excluded_territories as string[] | undefined) }]
            : []),
          ...("effective_from" in details || "effective_to" in details
            ? [{ label: "Period", value: periodLabel(details.effective_from as string | null, details.effective_to as string | null) }]
            : []),
          ...(typeof details.rule_scope === "string" ? [{ label: "Rule", value: `${details.rule_scope} · ${String(details.enforcement ?? "warn")}` }] : []),
          ...(Array.isArray(details.problems) ? [{ label: "Problems", value: (details.problems as string[]).map(titleCase).join(", ") }] : []),
          { label: "First detected", value: formatDateTime(conflict.created_at) },
          { label: "Last detected", value: formatDateTime(conflict.last_detected_at) },
          ...(conflict.resolved_at ? [{ label: "Closed", value: formatDateTime(conflict.resolved_at) }] : []),
        ]}
      />

      {conflict.resolution_notes ? (
        <section className="space-y-1.5">
          <Heading className="text-[13px] font-semibold">Review notes</Heading>
          <p className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3.5 py-3 text-[13px] text-fg-muted">{conflict.resolution_notes}</p>
        </section>
      ) : null}

      <section className="space-y-2">
        <Heading className="text-[13px] font-semibold">Involved shares ({shares.length})</Heading>
        {shares.length === 0 ? (
          <p className="text-[13px] text-fg-subtle">No individual shares are involved (for example, ownership is missing entirely).</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {shares.map((share) => (
              <li key={share.id} className="flex flex-wrap items-start justify-between gap-2 px-3.5 py-2.5 text-[13px]">
                <div className="min-w-0">
                  {share.party_id ? (
                    <Link href={`/catalog/parties/${share.party_id}`} className="font-medium text-fg hover:text-primary hover:underline">
                      {share.party_name ?? "Party"}
                    </Link>
                  ) : (
                    <span className="font-medium">{share.party_name ?? "Party"}</span>
                  )}
                  <p className="text-xs text-fg-subtle">
                    {share.role ? roleLabel(share.role) : "—"} · {territoryLabel(share.territories, share.excluded_territories)} · {periodLabel(share.effective_from, share.effective_to)}
                  </p>
                  <p className="font-mono text-2xs text-fg-subtle">{share.id}</p>
                </div>
                <span className="font-semibold tabular-nums">{formatPercent(share.share_percent)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit ? (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Heading className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Sparkles className="size-4 text-accent" aria-hidden /> Explain with AI
              </Heading>
              <p className="text-xs text-fg-muted">A plain-language explanation and next steps. The conflict is not changed.</p>
            </div>
            <Button size="sm" variant="soft" loading={explain.isPending} onClick={() => explain.mutate(conflict.id)} leftIcon={<Sparkles aria-hidden />}>
              {explain.data ? "Explain again" : "Explain with AI"}
            </Button>
          </div>
          {explain.error ? <AiErrorAlert error={explain.error} fallbackHint="The rule-based explanation above is always available." /> : null}
          {explain.data ? <AiExplanation data={explain.data} headingLevel={headingLevel} /> : null}
        </section>
      ) : null}

      {canEdit ? (
        <section className="flex flex-wrap gap-2 border-t border-border pt-4" aria-label="Conflict actions">
          {conflictActionsFor(conflict.status).map((value) => {
            const meta = ACTION_META[value];
            const Icon = meta.icon;
            return (
              <Button key={value} variant={value === "resolve" ? "primary" : "outline"} size="sm" leftIcon={<Icon aria-hidden />} onClick={() => setAction(value)}>
                {meta.label}
              </Button>
            );
          })}
        </section>
      ) : (
        <p className="text-xs text-fg-subtle">Managers can acknowledge, resolve, dismiss or reopen conflicts.</p>
      )}

      <TransitionDialog orgId={orgId} conflict={conflict} action={action} onClose={() => setAction(null)} />
    </div>
  );
}

function AiExplanation({ data, headingLevel }: { data: ConflictExplanation; headingLevel: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h3" : "h4";
  return (
    <div className="space-y-3 rounded-lg bg-accent-soft/40 p-3.5">
      <AiAdvisoryLabel notice={data.advisory_notice} />
      <p className="text-[13px] leading-relaxed text-fg">{data.summary}</p>
      {data.likely_causes.length > 0 ? (
        <div>
          <Heading className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Likely causes</Heading>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px]">
            {data.likely_causes.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.suggested_next_steps.length > 0 ? (
        <div>
          <Heading className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Suggested next steps</Heading>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[13px]">
            {data.suggested_next_steps.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {data.parties_involved.length > 0 ? (
        <ul className="space-y-1 text-[13px]">
          {data.parties_involved.map((party) => (
            <li key={party.party_id} className="flex gap-2">
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span>
                <span className="font-medium">{party.name ?? "Party"}</span>: {party.note}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.provider ? <p className="text-2xs text-fg-subtle">Model: {[data.provider, data.model].filter(Boolean).join(" / ")}</p> : null}
    </div>
  );
}

function TransitionDialog({ orgId, conflict, action, onClose }: { orgId: string; conflict: RightsConflict; action: ConflictAction | null; onClose: () => void }) {
  const transition = useConflictTransition(orgId);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsNotes = action ? conflictActionNeedsNotes(action) : false;
  const meta = action ? ACTION_META[action] : null;

  const close = () => {
    if (transition.isPending) return;
    setNotes("");
    setError(null);
    onClose();
  };
  const submit = () => {
    if (!action) return;
    if (needsNotes && !notes.trim()) {
      setError(`Notes are required to ${action} a conflict.`);
      return;
    }
    setError(null);
    transition.mutate(
      { id: conflict.id, action, notes },
      {
        onSuccess: () => {
          toast.success(`Conflict ${meta?.past}`);
          setNotes("");
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => !open && close()}
      title={meta ? `${meta.label} conflict` : ""}
      description={meta?.description}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={transition.isPending}>
            Cancel
          </Button>
          <Button variant={action === "dismiss" ? "danger" : "primary"} onClick={submit} loading={transition.isPending}>
            {meta?.label}
          </Button>
        </>
      }
    >
      <FormField label={needsNotes ? "Notes" : "Notes (optional)"} required={needsNotes} error={error ?? undefined} hint="Saved on the conflict and in the audit log.">
        <Textarea rows={4} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} autoFocus />
      </FormField>
    </Dialog>
  );
}
