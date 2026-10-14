"use client";

import { ShieldCheck } from "lucide-react";

import { anomalyLabel, severityTone } from "@/components/royalties/labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useStatementAnomalies } from "@/lib/api/hooks/royalties";
import { titleCase } from "@/lib/utils";

export function AnomaliesTab({ orgId, statementId }: { orgId: string; statementId: string }) {
  const report = useStatementAnomalies(orgId, statementId);

  if (report.isLoading) {
    return (
      <Card>
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </CardBody>
      </Card>
    );
  }
  if (report.error || !report.data) {
    return (
      <Card>
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      </Card>
    );
  }
  const data = report.data;
  const counts = Object.entries(data.counts_by_type ?? {});

  return (
    <Card>
      <CardHeader
        title="Anomaly checks"
        description={`Rule-based checks (no AI) across ${data.scanned_lines.toLocaleString()} lines: duplicates, negative amounts, rate outliers, usage without money and currency mismatches.`}
        actions={<Badge tone="neutral">Deterministic</Badge>}
      />
      {counts.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
          {counts.map(([type, count]) => (
            <Badge key={type} tone="neutral" size="md">
              {anomalyLabel(type)} · {count}
            </Badge>
          ))}
        </div>
      ) : null}
      {data.anomalies.length === 0 ? (
        <EmptyState icon={<ShieldCheck aria-hidden />} title="No anomalies found" description="None of the checks flagged lines on this statement." />
      ) : (
        <ul className="divide-y divide-border">
          {data.anomalies.map((anomaly, index) => (
            <li key={`${anomaly.type}-${index}`} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={severityTone(anomaly.severity)} dot>
                  {titleCase(anomaly.severity)} severity
                </Badge>
                <span className="text-[13px] font-semibold text-fg">{anomalyLabel(anomaly.type)}</span>
                {anomaly.isrc ? <span className="font-mono text-xs text-fg-muted">ISRC {anomaly.isrc}</span> : null}
                <span className="text-xs text-fg-subtle">
                  {anomaly.line_ids.length} line{anomaly.line_ids.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-fg">{anomaly.explanation}</p>
              {Object.keys(anomaly.metrics ?? {}).length > 0 ? (
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  {Object.entries(anomaly.metrics).map(([key, value]) => (
                    <div key={key} className="flex gap-1">
                      <dt className="text-fg-subtle">{titleCase(key)}:</dt>
                      <dd className="font-medium tabular-nums text-fg">{value ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data.truncated ? <p className="border-t border-border px-5 py-3 text-xs text-fg-subtle">Results were truncated; fix the flagged lines and re-check.</p> : null}
    </Card>
  );
}
