"use client";

import { FileBarChart, Sparkles } from "lucide-react";
import { useState } from "react";

import { AiErrorAlert, AiOutput, ManagerOnlyNotice } from "@/components/ai/ai-ui";
import { formatMoney } from "@/components/dashboard/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { fieldErrors } from "@/lib/api/errors";
import { useReportSummary, type ReportSummary, type ReportType } from "@/lib/api/hooks/ai";
import { formatDate, titleCase } from "@/lib/utils";

export const REPORT_TYPES: { value: ReportType; label: string; description: string }[] = [
  { value: "royalties_by_source", label: "Royalties by source", description: "Reported amounts per source and currency." },
  { value: "royalties_by_territory", label: "Royalties by territory", description: "Reported amounts per territory and currency." },
  { value: "catalog_health", label: "Catalog health", description: "Completeness and unresolved conflicts." },
  { value: "conflicts", label: "Rights conflicts", description: "Conflicts by type, severity and status." },
];

/** Mirrors the backend: end must not be before start. */
export function validatePeriod(start: string, end: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (start && end && end < start) errors.period_end = "End date must be on or after the start date.";
  return errors;
}

function cell(key: string, value: unknown, row: Record<string, unknown>): string {
  if (value === null || value === undefined) return "—";
  if (key === "amount" && typeof value === "string" && typeof row.currency === "string") return formatMoney(value, row.currency);
  if (key === "score_percent" && typeof value === "string") return `${value}%`;
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${titleCase(k)}: ${String(v)}`)
      .join(" · ");
  }
  if (key === "source_category" || key === "conflict_type" || key === "status" || key === "severity" || key === "entity_type") return titleCase(String(value));
  return String(value);
}

function FiguresTable({ figures }: { figures: Record<string, unknown>[] }) {
  const columns = Array.from(new Set(figures.flatMap((row) => Object.keys(row)))).filter((key) => key !== "currency" || !figures.some((row) => "amount" in row));
  return (
    <ScrollRegion>
      <table className="w-full min-w-[32rem] text-[13px]">
        <caption className="sr-only">Report figures computed from the database</caption>
        <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-2 font-semibold first:pl-5">
                {titleCase(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {figures.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className="px-3 py-2 text-fg-muted tabular-nums first:pl-5 first:font-medium first:text-fg">
                  {cell(column, row[column], row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function Totals({ totals }: { totals: Record<string, unknown> }) {
  const entries = Object.entries(totals);
  if (entries.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2 px-5 py-3 text-[13px]">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs text-fg-subtle">{titleCase(key)}</dt>
          <dd className="font-semibold text-fg">
            {key === "amount_by_currency" && value && typeof value === "object"
              ? Object.entries(value as Record<string, string>)
                  .map(([currency, amount]) => formatMoney(amount, currency))
                  .join(" · ")
              : value && typeof value === "object"
                ? Object.entries(value as Record<string, unknown>)
                    .map(([k, v]) => `${titleCase(k)}: ${String(v)}`)
                    .join(" · ")
                : key.endsWith("percent")
                  ? `${String(value)}%`
                  : typeof value === "number"
                    ? value.toLocaleString()
                    : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ReportPanel({ orgId, canRun, configured }: { orgId: string; canRun: boolean; configured: boolean }) {
  const [reportType, setReportType] = useState<ReportType>("royalties_by_source");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ReportSummary | null>(null);
  const report = useReportSummary(orgId);

  if (!canRun) return <ManagerOnlyNotice feature="Report summaries" />;

  const submit = () => {
    const problems = validatePeriod(start, end);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setResult(null);
    report.mutate(
      { report_type: reportType, period_start: start || null, period_end: end || null },
      {
        onSuccess: setResult,
        onError: (error) => setErrors(fieldErrors(error)),
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form
          className="grid gap-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField label="Report" hint={REPORT_TYPES.find((type) => type.value === reportType)?.description}>
            {(props) => <Select {...props} value={reportType} onValueChange={setReportType} options={REPORT_TYPES.map(({ value, label }) => ({ value, label }))} />}
          </FormField>
          <FormField label="Period start" error={errors.period_start} hint="Optional">
            <Input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
          </FormField>
          <FormField label="Period end" error={errors.period_end} hint="Optional">
            <Input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
          </FormField>
          <Button type="submit" loading={report.isPending} disabled={!configured} leftIcon={<Sparkles aria-hidden />} className="md:mt-[1.625rem]" title={configured ? undefined : "AI provider not configured"}>
            Summarize
          </Button>
        </form>
        <p className="mt-3 text-xs text-fg-subtle">
          Figures are computed from your database; the AI only writes the narrative around them and never converts or adds across currencies.
          {configured ? "" : " This feature needs an AI provider, so it is unavailable until one is configured."}
        </p>
      </Card>

      {report.error && Object.keys(errors).length === 0 ? <AiErrorAlert error={report.error} onRetry={submit} /> : null}

      {result ? (
        <>
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-fg">{REPORT_TYPES.find((type) => type.value === result.report_type)?.label ?? titleCase(result.report_type)} · figures</h3>
              <p className="text-xs text-fg-subtle">
                {result.period_start || result.period_end ? `${formatDate(result.period_start)} – ${formatDate(result.period_end)}` : "All periods"} · computed from your database
              </p>
            </div>
            {result.figures.length === 0 ? (
              <EmptyState compact icon={<FileBarChart aria-hidden />} title="No data for this report and period" description={result.message ?? undefined} />
            ) : (
              <>
                <Totals totals={result.totals} />
                <FiguresTable figures={result.figures} />
              </>
            )}
          </Card>
          {result.narrative ? (
            <AiOutput title={result.narrative.headline} provider={result.provider} model={result.model}>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{result.narrative.narrative}</p>
              {result.narrative.key_points.length > 0 ? (
                <div>
                  <h4 className="text-xs font-semibold text-fg-muted">Key points</h4>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-fg">
                    {result.narrative.key_points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.narrative.caveats.length > 0 ? (
                <div>
                  <h4 className="text-xs font-semibold text-fg-muted">Caveats</h4>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-fg-muted">
                    {result.narrative.caveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </AiOutput>
          ) : result.message && result.figures.length > 0 ? (
            <p className="text-[13px] text-fg-muted">{result.message}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
