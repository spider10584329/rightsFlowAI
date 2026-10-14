"use client";

import { ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AiErrorAlert, AiOutput } from "@/components/ai/ai-ui";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnomalies, useAnomalySummary, type AnomalySummary } from "@/lib/api/hooks/ai";
import { cn, titleCase } from "@/lib/utils";

const MONTH_OPTIONS = ["3", "6", "12", "24", "36"].map((value) => ({ value, label: `Last ${value} months` }));

const SEVERITY_TONE: Record<string, BadgeTone> = { high: "danger", medium: "warning", low: "neutral" };

export function AnomaliesPanel({ orgId, canRun, configured }: { orgId: string; canRun: boolean; configured: boolean }) {
  const [months, setMonths] = useState("12");
  const report = useAnomalies(orgId, Number(months));
  const summary = useAnomalySummary(orgId);
  const [summaryFor, setSummaryFor] = useState<{ months: string; data: AnomalySummary } | null>(null);
  const data = report.data;

  const summarize = () =>
    summary.mutate({ months: Number(months) }, { onSuccess: (result) => setSummaryFor({ months, data: result }) });

  const shownSummary = summaryFor && summaryFor.months === months ? summaryFor.data : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">Royalty anomalies</h2>
            <p className="text-xs text-fg-subtle">Rule-based detection (no AI): negative or zero lines, per-unit rate outliers and period-over-period swings.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" className="w-44" aria-label="Period" value={months} onValueChange={setMonths} options={MONTH_OPTIONS} />
            {canRun ? (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Sparkles aria-hidden />}
                onClick={summarize}
                loading={summary.isPending}
                disabled={!configured || !data || data.anomalies.length === 0}
                title={configured ? undefined : "AI provider not configured"}
              >
                Summarize with AI
              </Button>
            ) : null}
          </div>
        </div>

        {data ? (
          <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-5 py-3 text-[13px]">
            <span className="text-fg-muted">
              Scanned <span className="font-semibold text-fg tabular-nums">{data.scanned_statements.toLocaleString()}</span> statements ·{" "}
              <span className="font-semibold text-fg tabular-nums">{data.scanned_lines.toLocaleString()}</span> lines
            </span>
            {Object.entries(data.counts_by_type).map(([type, count]) => (
              <span key={type} className="text-fg-muted">
                {titleCase(type)}: <span className="font-semibold text-fg tabular-nums">{count}</span>
              </span>
            ))}
            {data.truncated ? <Badge tone="warning">Scan truncated — narrow the period</Badge> : null}
          </div>
        ) : null}

        {report.isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : report.error ? (
          <ErrorState error={report.error} onRetry={() => void report.refetch()} compact />
        ) : !data || data.anomalies.length === 0 ? (
          <EmptyState
            compact
            icon={<ShieldCheck aria-hidden />}
            title="No anomalies detected"
            description={data && data.scanned_lines === 0 ? "There are no processed statement lines in this period yet." : "Nothing unusual in the selected period."}
            action={
              data && data.scanned_lines === 0 ? (
                <Link href="/royalties/statements" className="text-[13px] font-medium text-primary hover:underline">
                  Import a statement
                </Link>
              ) : null
            }
          />
        ) : (
          <ScrollRegion className={cn(report.isFetching && "opacity-70")}>
            <table className="w-full min-w-[40rem] text-[13px]">
              <caption className="sr-only">Detected royalty anomalies</caption>
              <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <tr>
                  <th scope="col" className="px-5 py-2 font-semibold">Severity</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Type</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Finding</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Metrics</th>
                  <th scope="col" className="px-5 py-2 font-semibold">Records</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.anomalies.map((anomaly, index) => (
                  <tr key={`${anomaly.type}-${anomaly.statement_id}-${anomaly.line_ids.join(",")}-${index}`} className="align-top">
                    <td className="px-5 py-3">
                      <Badge tone={SEVERITY_TONE[anomaly.severity] ?? "neutral"} dot>
                        {titleCase(anomaly.severity)}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-medium text-fg">{titleCase(anomaly.type)}</td>
                    <td className="max-w-md px-3 py-3 text-fg-muted">{anomaly.explanation}</td>
                    <td className="px-3 py-3">
                      <dl className="space-y-0.5 text-xs">
                        {Object.entries(anomaly.metrics)
                          .filter(([, value]) => value !== null && value !== "")
                          .map(([key, value]) => (
                            <div key={key} className="flex gap-1.5">
                              <dt className="text-fg-subtle">{titleCase(key)}</dt>
                              <dd className="font-mono text-fg">{value}</dd>
                            </div>
                          ))}
                      </dl>
                    </td>
                    <td className="space-y-1 px-5 py-3 text-xs">
                      {anomaly.statement_id ? (
                        <Link href={`/royalties/statements/${anomaly.statement_id}`} className="block font-medium text-primary hover:underline">
                          Statement
                        </Link>
                      ) : null}
                      {anomaly.recording_id ? (
                        <Link href={`/catalog/recordings/${anomaly.recording_id}`} className="block font-medium text-primary hover:underline">
                          Recording{anomaly.isrc ? ` ${anomaly.isrc}` : ""}
                        </Link>
                      ) : anomaly.isrc ? (
                        <span className="block font-mono text-fg-muted">{anomaly.isrc}</span>
                      ) : null}
                      {anomaly.work_id ? (
                        <Link href={`/catalog/works/${anomaly.work_id}`} className="block font-medium text-primary hover:underline">
                          Work
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Card>

      {summary.error ? <AiErrorAlert error={summary.error} onRetry={summarize} /> : null}
      {shownSummary ? (
        shownSummary.ai_generated ? (
          <AiOutput title={`AI summary of ${shownSummary.anomaly_count} anomalies`} provider={shownSummary.provider} model={shownSummary.model}>
            {shownSummary.overview ? <p className="text-[13px] leading-relaxed text-fg">{shownSummary.overview}</p> : null}
            {shownSummary.key_findings.length > 0 ? (
              <div>
                <h4 className="text-xs font-semibold text-fg-muted">Key findings</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-fg">
                  {shownSummary.key_findings.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {shownSummary.recommended_checks.length > 0 ? (
              <div>
                <h4 className="text-xs font-semibold text-fg-muted">Recommended checks</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-fg">
                  {shownSummary.recommended_checks.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </AiOutput>
        ) : (
          <p className="text-[13px] text-fg-muted">{shownSummary.message}</p>
        )
      ) : null}
    </div>
  );
}
