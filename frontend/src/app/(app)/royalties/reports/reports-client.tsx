"use client";

import { BarChart3, Download, ListChecks } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { sourceCategoryLabel, statementStatus } from "@/components/royalties/labels";
import { Money, formatIsoDate } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { downloadReportExport, useExportReport, useReport, useReportTypes, waitForJob, type ReportFilters, type ReportResult } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { titleCase } from "@/lib/utils";

import { ReportChart } from "./report-chart";

const FILTERS = ["type", "from", "to", "currency"] as const;
const DEFAULT_TYPE = "revenue_by_source";

/** Columns that hold an id used for linking, not display. */
const ID_COLUMNS = new Set(["statement_id", "work_id", "recording_id", "party_id", "payee_id"]);
const MONEY_COLUMNS = new Set(["amount", "balance", "total_amount", "reported_total"]);
const COUNT_COLUMNS = new Set(["lines", "allocations", "entries", "rows", "valid_rows", "matched_rows"]);

const COLUMN_LABELS: Record<string, string> = {
  source_category: "Category",
  source_name: "Source",
  lines: "Lines",
  allocations: "Allocations",
  entries: "Entries",
  isrc: "ISRC",
  iswc: "ISWC",
  rows: "Rows",
};

export function ReportsClient() {
  const { org } = useOrg();
  const table = useTableQueryState<(typeof FILTERS)[number]>({ filterKeys: FILTERS });
  const types = useReportTypes(org.id);
  const currencies = useCurrencyCodes();
  const reportType = table.filters.type || DEFAULT_TYPE;
  const filters: ReportFilters = {
    period_start: table.filters.from || undefined,
    period_end: table.filters.to || undefined,
    currency: table.filters.currency || undefined,
  };
  const invalidRange = Boolean(filters.period_start && filters.period_end && filters.period_end < filters.period_start);
  const report = useReport(org.id, invalidRange ? null : reportType, filters);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Revenue, earnings and balances computed from processed statements and the ledger. Totals are exact and never converted between currencies."
        breadcrumbs={[{ label: "Royalties" }, { label: "Reports" }]}
        actions={
          <>
            <ButtonLink href="/royalties/unmatched" variant="outline" leftIcon={<ListChecks aria-hidden />}>
              Unmatched transactions
            </ButtonLink>
            <ExportButton orgId={org.id} reportType={reportType} filters={filters} disabled={invalidRange} />
          </>
        }
      />
      <Card className="mb-6">
        <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="space-y-1.5 lg:w-72">
            <label htmlFor="report-type" className="block text-[13px] font-medium text-fg">
              Report
            </label>
            <Select
              id="report-type"
              value={reportType}
              onValueChange={(v) => table.setFilter("type", v === DEFAULT_TYPE ? null : v)}
              options={Object.entries(types.data ?? { [DEFAULT_TYPE]: "Reported revenue by income source" }).map(([value, label]) => ({ value, label }))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="report-from" className="block text-[13px] font-medium text-fg">
              Period end from
            </label>
            <Input id="report-from" type="date" className="lg:w-44" value={table.filters.from} onChange={(e) => table.setFilter("from", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="report-to" className="block text-[13px] font-medium text-fg">
              Period end to
            </label>
            <Input id="report-to" type="date" className="lg:w-44" value={table.filters.to} min={table.filters.from || undefined} onChange={(e) => table.setFilter("to", e.target.value)} aria-invalid={invalidRange || undefined} />
          </div>
          <div className="space-y-1.5 lg:w-40">
            <label htmlFor="report-currency" className="block text-[13px] font-medium text-fg">
              Currency
            </label>
            <Select
              id="report-currency"
              value={table.filters.currency || "all"}
              onValueChange={(v) => table.setFilter("currency", v === "all" ? null : v)}
              options={[{ value: "all", label: "All currencies" }, ...currencies.map((c) => ({ value: c, label: c }))]}
            />
          </div>
          {table.filters.from || table.filters.to || table.filters.currency ? (
            <Button variant="ghost" size="sm" onClick={() => table.reset()} className="lg:ml-auto">
              Reset
            </Button>
          ) : null}
        </div>
        {invalidRange ? (
          <p role="alert" className="border-t border-border px-5 py-2 text-xs font-medium text-danger">
            The end date must be on or after the start date.
          </p>
        ) : null}
      </Card>

      {invalidRange ? null : report.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : report.error || !report.data ? (
        <Card>
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        </Card>
      ) : (
        <ReportView report={report.data} fetching={report.isFetching} />
      )}
    </>
  );
}

function amountKey(report: ReportResult): string | null {
  if (report.columns.includes("balance")) return "balance";
  if (report.columns.includes("amount")) return "amount";
  return null;
}

function labelFor(report: ReportResult, row: ReportResult["rows"][number]): string {
  switch (report.report_type) {
    case "revenue_by_source":
      return `${row.source_name ?? "—"}`;
    case "revenue_by_territory":
      return String(row.territory ?? "Unknown");
    case "revenue_by_work":
    case "revenue_by_recording":
      return String(row.title ?? "Untitled");
    case "earnings_by_payee":
    case "payee_balances":
      return String(row.payee ?? "—");
    default:
      return String(row.source ?? row.title ?? "—");
  }
}

function ReportView({ report, fetching }: { report: ReportResult; fetching: boolean }) {
  const key = amountKey(report);
  const totals = Object.entries(report.totals_by_currency ?? {});
  const visibleColumns = report.columns.filter((c) => !ID_COLUMNS.has(c));
  const currenciesInRows = [...new Set(report.rows.map((r) => String(r.currency ?? "")).filter(Boolean))];
  const chartCurrency = report.filters.currency ?? (currenciesInRows.length === 1 ? currenciesInRows[0] : (totals[0]?.[0] ?? null));
  const chartRows = key && chartCurrency ? report.rows.filter((r) => r.currency === chartCurrency).slice(0, 10) : [];

  if (report.rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<BarChart3 aria-hidden />}
          title="No data for this report"
          description={
            report.report_type.startsWith("revenue")
              ? "Revenue reports include processed, calculated and posted statements. Upload and process a statement, or widen the period."
              : report.report_type === "earnings_by_payee"
                ? "Earnings appear once a calculation run is posted to the ledger."
                : "Try a wider period or another currency."
          }
          action={
            <ButtonLink href="/royalties/statements" size="sm" variant="outline">
              Go to statements
            </ButtonLink>
          }
        />
      </Card>
    );
  }

  return (
    <div className={`space-y-6 ${fetching ? "opacity-80 transition-opacity" : ""}`}>
      {totals.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {totals.map(([currency, amount]) => (
            <StatCard key={currency} label={`Total · ${currency}`} value={<Money amount={amount} currency={currency} />} hint={report.truncated ? "All rows, including those not shown" : `${report.rows.filter((r) => r.currency === currency).length} rows`} />
          ))}
        </div>
      ) : null}
      {chartRows.length > 1 && key && chartCurrency ? (
        <Card>
          <CardHeader
            title={`Top ${chartRows.length} by ${key === "balance" ? "balance" : "amount"}`}
            description={currenciesInRows.length > 1 ? `${chartCurrency} only — currencies are never mixed in one chart. Filter by currency to switch.` : chartCurrency}
          />
          <ReportChart data={chartRows.map((row) => ({ label: labelFor(report, row), value: String(row[key] ?? "0") }))} currency={chartCurrency} />
        </Card>
      ) : null}
      <Card>
        <CardHeader
          title={report.title}
          description={
            report.truncated && report.row_count
              ? `Showing the top ${report.rows.length.toLocaleString()} of ${report.row_count.toLocaleString()} rows. Totals include every row; export for the full list.`
              : `${report.rows.length.toLocaleString()} rows`
          }
        />
        <ScrollRegion>
          <table className="w-full min-w-[36rem] text-[13px]">
            <caption className="sr-only">{report.title}</caption>
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                {visibleColumns.map((column) => (
                  <th key={column} scope="col" className={`px-5 py-2 font-medium ${MONEY_COLUMNS.has(column) || COUNT_COLUMNS.has(column) ? "text-right" : "text-left"}`}>
                    {COLUMN_LABELS[column] ?? titleCase(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row, index) => (
                <tr key={index} className="border-b border-border last:border-0 hover:bg-surface-2/50">
                  {visibleColumns.map((column) => (
                    <td key={column} className={`px-5 py-2 ${MONEY_COLUMNS.has(column) || COUNT_COLUMNS.has(column) ? "text-right tabular-nums" : ""}`}>
                      <Cell row={row} column={column} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals.length > 0 && key ? (
              <tfoot>
                {totals.map(([currency, amount]) => (
                  <tr key={currency} className="border-t border-border-strong bg-surface-2/50 font-semibold">
                    {visibleColumns.map((column, index) => (
                      <td key={column} className={`px-5 py-2 ${column === key ? "text-right" : ""}`}>
                        {index === 0 ? `Total ${currency}` : column === key ? <Money amount={amount} currency={currency} /> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tfoot>
            ) : null}
          </table>
        </ScrollRegion>
      </Card>
    </div>
  );
}

function Cell({ row, column }: { row: ReportResult["rows"][number]; column: string }) {
  const value = row[column];
  if (value === null || value === undefined || value === "") return <span className="text-fg-subtle">—</span>;
  const currency = typeof row.currency === "string" ? row.currency : null;
  if (MONEY_COLUMNS.has(column)) return <Money amount={String(value)} currency={currency} precision={column === "balance" ? "exact" : "standard"} />;
  if (COUNT_COLUMNS.has(column)) return <>{Number(value).toLocaleString()}</>;
  if (column === "source_category") return <>{sourceCategoryLabel(String(value))}</>;
  if (column === "status") return <>{statementStatus(String(value)).label}</>;
  if (column === "period_start" || column === "period_end") return <>{formatIsoDate(String(value))}</>;
  if ((column === "source" || column === "source_name") && row.statement_id) {
    return (
      <Link href={`/royalties/statements/${row.statement_id}`} className="font-medium text-primary hover:underline">
        {String(value)}
      </Link>
    );
  }
  if (column === "payee" && row.payee_id) {
    return (
      <Link href={`/payouts/payees/${row.payee_id}`} className="font-medium text-primary hover:underline">
        {String(value)}
      </Link>
    );
  }
  if (column === "isrc" || column === "iswc") return <span className="font-mono text-xs">{String(value)}</span>;
  return <>{String(value)}</>;
}

function ExportButton({ orgId, reportType, filters, disabled }: { orgId: string; reportType: string; filters: ReportFilters; disabled?: boolean }) {
  const exporter = useExportReport(orgId);
  const [progress, setProgress] = useState<number | null>(null);

  const run = async () => {
    setProgress(0);
    try {
      const { job_id } = await exporter.mutateAsync({ reportType, filters });
      toast.info("Preparing export…", { description: "The CSV downloads automatically when it is ready." });
      await waitForJob(orgId, job_id, (job) => setProgress(job.progress));
      await downloadReportExport(orgId, job_id);
      toast.success("Report exported", { description: "The CSV has been downloaded." });
    } catch (error) {
      toast.error("Export failed", { description: errorMessage(error) });
    } finally {
      setProgress(null);
    }
  };

  return (
    <Button leftIcon={<Download aria-hidden />} disabled={disabled} loading={progress !== null} onClick={() => void run()}>
      {progress !== null ? `Exporting${progress > 0 ? ` ${progress}%` : "…"}` : "Export CSV"}
    </Button>
  );
}
