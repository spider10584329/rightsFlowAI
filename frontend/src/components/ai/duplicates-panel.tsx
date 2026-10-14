"use client";

import { Copy, Sparkles } from "lucide-react";
import { useState } from "react";

import { AiErrorAlert, AiOutput, RecordLink } from "@/components/ai/ai-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDuplicateCandidates, useExplainDuplicate, type DuplicateCandidate, type DuplicateEntityType, type DuplicateExplainResponse } from "@/lib/api/hooks/ai";
import { cn, titleCase } from "@/lib/utils";

const ENTITY_OPTIONS: { value: DuplicateEntityType; label: string }[] = [
  { value: "work", label: "Works" },
  { value: "recording", label: "Recordings" },
  { value: "release", label: "Releases" },
  { value: "party", label: "Parties" },
];

const pairKey = (candidate: DuplicateCandidate) => candidate.ids.join("|");

export function DuplicatesPanel({ orgId, canRun, configured }: { orgId: string; canRun: boolean; configured: boolean }) {
  const [entityType, setEntityType] = useState<DuplicateEntityType>("work");
  const candidates = useDuplicateCandidates(orgId, entityType);
  const explain = useExplainDuplicate(orgId);
  const [explanations, setExplanations] = useState<Record<string, DuplicateExplainResponse>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [pending, setPending] = useState<string | null>(null);

  const runExplain = (candidate: DuplicateCandidate) => {
    const key = pairKey(candidate);
    setPending(key);
    setErrors((current) => ({ ...current, [key]: undefined }));
    explain.mutate(
      { entity_type: entityType, ids: candidate.ids.slice(0, 2) },
      {
        onSuccess: (data) => setExplanations((current) => ({ ...current, [key]: data })),
        onError: (error) => setErrors((current) => ({ ...current, [key]: error })),
        onSettled: () => setPending(null),
      },
    );
  };

  const list = candidates.data?.candidates ?? [];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Duplicate candidates</h2>
          <p className="text-xs text-fg-subtle">Deterministic matching on identifiers and normalised titles. Nothing is merged automatically.</p>
        </div>
        <Select size="sm" className="sm:w-40" aria-label="Record type" value={entityType} onValueChange={setEntityType} options={ENTITY_OPTIONS} />
      </div>
      {candidates.isLoading ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : candidates.error ? (
        <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} compact />
      ) : list.length === 0 ? (
        <EmptyState compact icon={<Copy aria-hidden />} title={`No duplicate ${entityType}s found`} description="Records with matching identifiers or very similar titles would appear here." />
      ) : (
        <ul className={cn("divide-y divide-border", candidates.isFetching && "opacity-70")}>
          {list.map((candidate) => {
            const key = pairKey(candidate);
            const result = explanations[key];
            const error = errors[key];
            const score = Math.round(candidate.score * 100);
            return (
              <li key={key} className="space-y-3 px-5 py-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      {candidate.ids.map((id, index) => (
                        <span key={id} className="inline-flex items-center gap-2">
                          {index > 0 ? <span className="text-fg-subtle">vs</span> : null}
                          <RecordLink entityType={candidate.entity_type} id={id}>
                            {candidate.titles[index] ?? id}
                          </RecordLink>
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={score >= 100 ? "danger" : score >= 85 ? "warning" : "neutral"}>Match score {score}%</Badge>
                      {candidate.reasons.map((reason) => (
                        <Badge key={reason} tone="neutral">
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {canRun ? (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Sparkles aria-hidden />}
                      onClick={() => runExplain(candidate)}
                      loading={pending === key}
                      disabled={!configured || (pending !== null && pending !== key)}
                      title={configured ? undefined : "AI provider not configured"}
                    >
                      Explain with AI
                    </Button>
                  ) : null}
                </div>
                {error ? <AiErrorAlert error={error} onRetry={() => runExplain(candidate)} /> : null}
                {result ? (
                  <AiOutput provider={result.provider} model={result.model}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={result.likely_duplicate ? "warning" : "success"} dot>
                        {result.likely_duplicate ? "Likely duplicate" : "Probably distinct"}
                      </Badge>
                      <Badge tone="neutral">{titleCase(result.confidence)} confidence</Badge>
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{result.explanation}</p>
                    <p className="text-[13px] text-fg-muted">
                      <span className="font-medium text-fg">Recommended: </span>
                      {result.recommended_action}
                    </p>
                    <p className="text-2xs text-fg-subtle">No records were merged. Merge or archive manually from the catalog if appropriate.</p>
                  </AiOutput>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
