"use client";

import { ClipboardCheck } from "lucide-react";

import { RecordLink } from "@/components/ai/ai-ui";
import { formatPercent, toDisplayNumber } from "@/components/dashboard/format";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompleteness } from "@/lib/api/hooks/ai";
import { cn, titleCase } from "@/lib/utils";

function scoreTone(percent: number): "success" | "warning" | "danger" {
  if (percent >= 90) return "success";
  if (percent >= 60) return "warning";
  return "danger";
}

const ACRONYMS = new Set(["isrc", "iswc", "upc", "ipi", "isni"]);

/** "isrc" -> "ISRC", "p_line" -> "P line". */
export function checkLabel(check: string): string {
  if (ACRONYMS.has(check.toLowerCase())) return check.toUpperCase();
  const text = check.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SCORE_TEXT = { success: "Good", warning: "Needs work", danger: "Poor" } as const;

export function CompletenessPanel({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const query = useCompleteness(orgId);
  const data = query.data;

  if (query.isLoading) return <Skeleton className="h-72 rounded-xl" />;
  if (query.error || !data) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} compact />
      </Card>
    );
  }

  const totalRecords = data.entities.reduce((sum, entity) => sum + entity.total, 0);
  if (totalRecords === 0) {
    return (
      <Card>
        <EmptyState
          icon={<ClipboardCheck aria-hidden />}
          title="Nothing to score yet"
          description="Completeness is measured on works, recordings and releases. Add some to see which identifiers and links are missing."
          action={canEdit ? <ButtonLink href="/catalog/works" size="sm" variant="outline">Add works</ButtonLink> : null}
        />
      </Card>
    );
  }

  const overall = toDisplayNumber(data.overall_score_percent) ?? 0;
  const overallTone = scoreTone(overall);

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-[13px] font-medium text-fg-muted">Overall metadata completeness</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight text-fg">{formatPercent(data.overall_score_percent)}</p>
        </div>
        <div className="flex-1 space-y-1 sm:ml-6">
          <div role="meter" aria-label="Overall completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall)} className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div className={cn("h-full rounded-full", overallTone === "success" ? "bg-success" : overallTone === "warning" ? "bg-warning" : "bg-danger")} style={{ width: `${Math.min(100, Math.max(0, overall))}%` }} />
          </div>
          <p className="text-xs text-fg-subtle">
            {SCORE_TEXT[overallTone]} · deterministic score (source: {data.source}) · average share of required fields present per record
          </p>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {data.entities.map((entity) => {
          const score = toDisplayNumber(entity.score_percent) ?? 0;
          const tone = scoreTone(score);
          return (
            <Card key={entity.entity_type} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h3 className="text-[15px] font-semibold text-fg">{titleCase(entity.entity_type)}s</h3>
                  <p className="text-xs text-fg-subtle">
                    {entity.complete.toLocaleString()} of {entity.total.toLocaleString()} complete
                  </p>
                </div>
                <Badge tone={entity.total === 0 ? "neutral" : tone} size="md">
                  {entity.total === 0 ? "No records" : `${formatPercent(entity.score_percent)} · ${SCORE_TEXT[tone]}`}
                </Badge>
              </div>
              <div className="space-y-3 px-5 py-4">
                {entity.checks.map((check) => {
                  const total = check.present + check.missing;
                  const presentPct = total > 0 ? (check.present / total) * 100 : 0;
                  return (
                    <div key={check.check}>
                      <div className="flex justify-between text-[13px]">
                        <span className="text-fg">{checkLabel(check.check)}</span>
                        <span className="text-xs text-fg-muted tabular-nums">
                          {total === 0 ? "—" : check.missing > 0 ? `${check.missing.toLocaleString()} missing` : "All present"}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${presentPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {entity.incomplete_sample.length > 0 ? (
                <div className="mt-auto border-t border-border px-5 py-3">
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Incomplete examples</p>
                  <ul className="space-y-1.5">
                    {entity.incomplete_sample.slice(0, 6).map((item) => (
                      <li key={item.id} className="text-[13px]">
                        <RecordLink entityType={entity.entity_type} id={item.id}>
                          {item.title}
                        </RecordLink>
                        <span className="block text-xs text-fg-subtle">Missing: {item.missing.map(checkLabel).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
