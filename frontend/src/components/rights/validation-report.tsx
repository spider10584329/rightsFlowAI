"use client";

import { Ban, CheckCircle2, TriangleAlert } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RightsValidationIssue, ValidationResult } from "@/lib/api/hooks/rights";

import { SeverityBadge, TotalStatusBadge } from "./badges";
import { CONFLICT_TYPE_EXPLAINERS, conflictTypeLabel, describeValidation, formatPercent, periodLabel, rightsTypeLabel } from "./rights-format";

/** Plain-language list of validation issues with block-vs-warn labelling. */
export function IssueList({ issues, emptyText }: { issues: RightsValidationIssue[]; emptyText?: string }) {
  if (issues.length === 0) {
    return emptyText ? (
      <p className="flex items-center gap-2 text-[13px] text-fg-muted">
        <CheckCircle2 className="size-4 text-success" aria-hidden /> {emptyText}
      </p>
    ) : null;
  }
  return (
    <ul className="space-y-2">
      {issues.map((issue, index) => (
        <li key={`${issue.type}-${index}`} className="rounded-lg border border-border bg-surface-2/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {issue.blocking ? (
              <Badge tone="danger" className="gap-1">
                <Ban className="size-3" aria-hidden /> Blocks saving
              </Badge>
            ) : (
              <Badge tone="warning" className="gap-1">
                <TriangleAlert className="size-3" aria-hidden /> Warning
              </Badge>
            )}
            <SeverityBadge severity={issue.severity} />
            <Badge tone="neutral">{conflictTypeLabel(issue.type)}</Badge>
            {issue.rights_type ? <Badge tone="primary">{rightsTypeLabel(issue.rights_type)}</Badge> : null}
          </div>
          <p className="mt-2 text-[13px] font-medium text-fg">{issue.title}</p>
          {CONFLICT_TYPE_EXPLAINERS[issue.type] ? <p className="mt-1 text-xs text-fg-muted">{CONFLICT_TYPE_EXPLAINERS[issue.type]}</p> : null}
          <details className="mt-1.5 text-xs text-fg-subtle">
            <summary className="cursor-pointer select-none hover:text-fg">Full explanation</summary>
            <p className="mt-1 leading-relaxed">{issue.message}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Result of a dry-run or write validation: headline, per-territory totals and issues. */
export function ValidationReport({ result, title = "Validation result" }: { result: ValidationResult; title?: string }) {
  const display = describeValidation(result);
  return (
    <section aria-label={title} className="space-y-4">
      <Alert tone={display.tone} title={display.headline} assertive={display.tone === "danger"}>
        {display.detail}
      </Alert>
      {result.totals.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <caption className="sr-only">Totals per territory group and period</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Rights</TableHead>
                <TableHead>Territories</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.totals.map((segment, index) => (
                <TableRow key={index}>
                  <TableCell>{rightsTypeLabel(segment.rights_type)}</TableCell>
                  <TableCell className="max-w-[16rem]">
                    <span className="line-clamp-2 text-[13px]" title={segment.territory_label}>
                      {segment.territory_label}
                    </span>
                    <span className="text-2xs text-fg-subtle">{segment.country_count} countries</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">{periodLabel(segment.effective_from, segment.effective_to)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatPercent(segment.total)}</TableCell>
                  <TableCell className="text-right tabular-nums text-fg-muted">
                    {formatPercent(segment.expected_total)}
                    <span className="block text-2xs">±{formatPercent(segment.tolerance)}</span>
                  </TableCell>
                  <TableCell>
                    <TotalStatusBadge status={segment.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <IssueList issues={result.issues} />
    </section>
  );
}
