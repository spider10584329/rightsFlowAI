"use client";

import { CheckCircle2, OctagonAlert, Scale } from "lucide-react";
import Link from "next/link";

import { rightsTypeLabel, sourceCategoryLabel } from "@/components/royalties/labels";
import { addDecimals, decimalSign, isZeroDecimal } from "@/components/royalties/money";
import { Money, RunStatusBadge, formatPeriod } from "@/components/royalties/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { KeyValueList } from "@/components/ui/key-value";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { useReconciliation, type LatestRunSummary, type Statement, type StatementError } from "@/lib/api/hooks/royalties";
import { formatDateTime, titleCase } from "@/lib/utils";

export function OverviewTab({ orgId, statement: s }: { orgId: string; statement: Statement }) {
  const processed = !["uploaded", "queued", "processing"].includes(s.status);
  const reconciliation = useReconciliation(orgId, s.id, processed);
  const errors = (s.errors ?? []) as unknown as StatementError[];
  const matchedPct = s.valid_rows > 0 ? Math.round((s.matched_rows / s.valid_rows) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Statement total" value={<Money amount={s.total_amount} currency={s.currency} />} hint={`${s.currency} · valid lines`} />
        <StatCard label="Rows" value={s.total_rows.toLocaleString()} hint={processed ? `${s.valid_rows.toLocaleString()} valid · ${s.error_rows.toLocaleString()} with errors` : "Not processed yet"} />
        <StatCard label="Matched" value={processed ? `${matchedPct}%` : "—"} hint={processed ? `${s.matched_rows.toLocaleString()} of ${s.valid_rows.toLocaleString()} valid rows` : undefined} />
        <StatCard
          label="Reported total"
          value={<Money amount={s.reported_total} currency={s.currency} />}
          hint={s.reported_total ? "As printed on the statement" : "Not provided at upload"}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Scale className="size-4 text-fg-subtle" aria-hidden /> Reconciliation
              </span>
            }
            description={`Valid lines in ${s.currency} split by match status, compared with the reported total.`}
          />
          <CardBody>
            {!processed ? (
              <p className="text-[13px] text-fg-muted">Reconciliation is available after processing.</p>
            ) : reconciliation.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : reconciliation.error || !reconciliation.data ? (
              <ErrorState error={reconciliation.error} onRetry={() => void reconciliation.refetch()} compact />
            ) : (
              <ReconciliationView data={reconciliation.data} statementId={s.id} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Details" />
          <CardBody className="py-1">
            <KeyValueList
              items={[
                { label: "Source", value: s.source_name },
                { label: "Category", value: sourceCategoryLabel(s.source_category) },
                { label: "Period", value: formatPeriod(s.period_start, s.period_end) },
                { label: "Currency", value: s.currency },
                { label: "Default rights type", value: s.default_rights_type ? rightsTypeLabel(s.default_rights_type) : "Category default" },
                { label: "Format", value: titleCase(s.adapter) },
                { label: "File", value: s.file_name ?? "Manual statement" },
                { label: "Uploaded", value: formatDateTime(s.created_at) },
                { label: "Processed", value: formatDateTime(s.processed_at) },
                ...(s.notes ? [{ label: "Notes", value: s.notes }] : []),
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {errors.length > 0 ? (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <OctagonAlert className="size-4 text-danger" aria-hidden /> Errors
              </span>
            }
            description={
              s.status === "failed"
                ? "The file could not be processed. Fix the mapping or the file and reprocess."
                : `${s.error_rows.toLocaleString()} rows were invalid and are excluded from calculations. Showing the first ${errors.length}.`
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Row errors</caption>
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                  <th scope="col" className="w-24 px-5 py-2 font-medium">
                    Row
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Problems
                  </th>
                </tr>
              </thead>
              <tbody>
                {errors.map((error, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    <td className="px-5 py-2 tabular-nums text-fg-muted">{error.row ?? "—"}</td>
                    <td className="px-5 py-2 text-fg">{error.errors.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ReconciliationView({ data, statementId }: { data: NonNullable<ReturnType<typeof useReconciliation>["data"]>; statementId: string }) {
  const currency = data.currency;
  const difference = data.reported_difference;
  const reconciled = difference !== null && difference !== undefined && isZeroDecimal(difference);
  const latest = data.latest_run as LatestRunSummary | null;
  const others = Object.entries(data.other_currency_totals ?? {});
  // matched + unmatched must equal the statement total exactly (ignored lines are excluded).
  const check = addDecimals(data.matched_amount, data.unmatched_amount);

  const rows: { label: string; count: number; amount: string; tone?: string; hint?: string }[] = [
    { label: "Matched", count: data.matched_rows, amount: data.matched_amount, hint: "Matched to a recording or work" },
    { label: "Unmatched", count: data.unmatched_rows, amount: data.unmatched_amount, hint: "Held as unallocated until matched" },
    { label: "Ignored", count: data.ignored_rows, amount: data.ignored_amount, hint: "Excluded from the statement total" },
  ];

  return (
    <div className="space-y-5">
      <table className="w-full text-[13px]">
        <caption className="sr-only">Reconciliation by match status</caption>
        <thead>
          <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
            <th scope="col" className="py-2 font-medium">
              Lines
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Count
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border">
              <th scope="row" className="py-2 text-left font-normal">
                <span className="font-medium text-fg">{row.label}</span>
                <span className="block text-xs text-fg-subtle">{row.hint}</span>
              </th>
              <td className="py-2 text-right tabular-nums text-fg-muted">{row.count.toLocaleString()}</td>
              <td className="py-2 text-right">
                <Money amount={row.amount} currency={currency} precision="exact" />
              </td>
            </tr>
          ))}
          <tr className="border-b border-border bg-surface-2/50">
            <th scope="row" className="py-2 text-left font-semibold text-fg">
              Statement total
            </th>
            <td className="py-2 text-right tabular-nums text-fg-muted">{(data.matched_rows + data.unmatched_rows).toLocaleString()}</td>
            <td className="py-2 text-right font-semibold" title={`Matched + unmatched = ${check}`}>
              <Money amount={data.statement_total} currency={currency} precision="exact" />
            </td>
          </tr>
          <tr className="border-b border-border">
            <th scope="row" className="py-2 text-left font-normal text-fg-muted">
              Reported total
            </th>
            <td />
            <td className="py-2 text-right">
              <Money amount={data.reported_total} currency={currency} precision="exact" />
            </td>
          </tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-fg-muted">
              Difference (statement − reported)
            </th>
            <td className="py-2 text-right">
              {difference === null || difference === undefined ? null : reconciled ? (
                <Badge tone="success">
                  <CheckCircle2 className="size-3" aria-hidden /> Reconciled
                </Badge>
              ) : (
                <Badge tone="warning">Difference</Badge>
              )}
            </td>
            <td className="py-2 text-right">
              {difference === null || difference === undefined ? (
                <span className="text-xs text-fg-subtle">No reported total</span>
              ) : (
                <Money amount={difference} currency={currency} precision="exact" signDisplay="exceptZero" className={decimalSign(difference) !== 0 ? "font-semibold text-warning" : "text-success"} />
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-fg-subtle">
        {data.total_rows.toLocaleString()} rows · {data.valid_rows.toLocaleString()} valid · {data.invalid_rows.toLocaleString()} invalid (excluded).
      </p>
      {others.length > 0 ? (
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="text-[13px] font-medium text-fg">Lines in other currencies</p>
          <p className="mb-2 text-xs text-fg-subtle">Not included above — no FX conversion is applied.</p>
          <ul className="space-y-1 text-[13px]">
            {others.map(([code, amount]) => (
              <li key={code} className="flex justify-between">
                <span className="text-fg-muted">{code}</span>
                <Money amount={amount} currency={code} precision="exact" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {latest ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/40 px-4 py-3 text-[13px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-fg">Latest calculation</span>
            <RunStatusBadge status={latest.status} />
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            <span>
              Payable <Money amount={latest.total_payable} currency={currency} className="font-medium" />
            </span>
            <span>
              Retained <Money amount={latest.total_retained} currency={currency} className="font-medium" />
            </span>
            <span>
              Unallocated <Money amount={latest.total_unallocated} currency={currency} className="font-medium" />
            </span>
          </div>
          <Link href={`/royalties/runs/${latest.id}`} className="text-[13px] font-medium text-primary hover:underline">
            Open run
          </Link>
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">
          No calculation yet.{" "}
          <Link href={`/royalties/statements/${statementId}?tab=calculation`} className="text-primary hover:underline">
            Calculate royalties
          </Link>
        </p>
      )}
    </div>
  );
}
