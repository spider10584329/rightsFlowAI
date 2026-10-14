"use client";

import { AlertTriangle, ArrowRight, Disc3, FileSignature, FileText, Mic2, Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatCount, formatMoney, isZeroAmount, otherCurrenciesNote } from "@/components/dashboard/format";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import type { DashboardSummary } from "@/lib/api/hooks/dashboard";
import { cn, pluralize } from "@/lib/utils";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "medium":
      return "info";
    default:
      return "neutral";
  }
}

/** Whole-card link. The visible figures stay in the accessible name; `action` is appended for screen readers. */
function LinkedStat({ href, children, action }: { href: string; children: ReactNode; action: string }) {
  return (
    <Link
      href={href}
      className="group block rounded-xl transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>div]:h-full [&>div]:transition-colors hover:[&>div]:border-border-strong"
    >
      {children}
      <span className="sr-only">, {action}</span>
    </Link>
  );
}

/** The single hero figure plus money KPIs, all in the primary currency (other currencies listed, never converted). */
export function MoneyKpis({ summary }: { summary: DashboardSummary }) {
  const { reported_royalties: royalties, payable_balances: payable, unmatched_transactions: unmatched } = summary;
  const allTimeOthers = otherCurrenciesNote(royalties.all_time.other_currencies);
  const yearOthers = otherCurrenciesNote(royalties.current_year.other_currencies);
  const payableOthers = payable.other_currencies.filter((entry) => !isZeroAmount(entry.gross_balance));
  const unmatchedOthers = unmatched.other_currencies.filter((entry) => entry.count > 0);

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <Card className="relative overflow-hidden p-6 lg:col-span-2">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-medium text-fg-muted">Reported royalties · all time</p>
          <Link href="/royalties/statements" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Statements <ArrowRight className="size-3" aria-hidden />
          </Link>
        </div>
        <p className="mt-3 text-4xl font-semibold tracking-tight text-fg sm:text-5xl">{formatMoney(royalties.all_time.amount, royalties.all_time.currency)}</p>
        {allTimeOthers ? <p className="mt-2 text-xs text-fg-subtle">Also reported in other currencies: {allTimeOthers}</p> : null}
        <div className="mt-5 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-fg-muted">Reported in {royalties.current_year.year}</p>
            <p className="mt-1 text-lg font-semibold text-fg">{formatMoney(royalties.current_year.amount, royalties.current_year.currency)}</p>
            {yearOthers ? <p className="mt-0.5 text-2xs text-fg-subtle">+ {yearOthers}</p> : null}
          </div>
          <div>
            <p className="text-xs text-fg-muted">Definition</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
              Sum of valid statement lines in processed, calculated or posted statements. No currency conversion.
            </p>
          </div>
        </div>
      </Card>

      <LinkedStat href="/payouts" action="view payouts">
        <StatCard
          label="Outstanding payable"
          icon={<Wallet aria-hidden />}
          value={formatMoney(payable.gross_balance, payable.currency)}
          hint={
            <span className="space-y-0.5">
              <span className="block">
                Available {formatMoney(payable.available, payable.currency)} · reserved {formatMoney(payable.reserved_in_payouts, payable.currency)}
              </span>
              <span className="block">{pluralize(payable.payee_count, "payee")} with a balance</span>
              {payableOthers.length > 0 ? (
                <span className="block">+ {payableOthers.map((entry) => formatMoney(entry.gross_balance, entry.currency)).join(" · ")}</span>
              ) : null}
            </span>
          }
        />
      </LinkedStat>

      <LinkedStat href="/royalties/statements" action="view statements">
        <StatCard
          label="Unmatched transactions"
          icon={<AlertTriangle aria-hidden />}
          value={formatCount(unmatched.count)}
          hint={
            <span className="space-y-0.5">
              <span className="block">
                {formatMoney(unmatched.amount, unmatched.currency)} across {pluralize(unmatched.primary_count, "line")} in {unmatched.currency}
              </span>
              {unmatchedOthers.length > 0 ? (
                <span className="block">
                  + {unmatchedOthers.map((entry) => `${formatMoney(entry.amount, entry.currency)} (${formatCount(entry.count)})`).join(" · ")}
                </span>
              ) : null}
              <span className="block">Lines in statements not yet posted</span>
            </span>
          }
        />
      </LinkedStat>
    </div>
  );
}

export function CatalogKpis({ summary }: { summary: DashboardSummary }) {
  const { catalog, active_contracts: activeContracts, open_conflicts: conflicts } = summary;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <LinkedStat href="/catalog/works" action="view works">
        <StatCard label="Works" icon={<FileText aria-hidden />} value={formatCount(catalog.works)} hint={`${pluralize(catalog.parties, "party", "parties")} in the catalog`} />
      </LinkedStat>
      <LinkedStat href="/catalog/recordings" action="view recordings">
        <StatCard
          label="Recordings"
          icon={<Mic2 aria-hidden />}
          value={formatCount(catalog.recordings)}
          hint={
            <span className="inline-flex items-center gap-1">
              <Disc3 className="size-3" aria-hidden /> {pluralize(catalog.releases, "release")}
            </span>
          }
        />
      </LinkedStat>
      <LinkedStat href="/contracts" action="view contracts">
        <StatCard
          label="Active contracts"
          icon={<FileSignature aria-hidden />}
          value={formatCount(activeContracts)}
          hint={
            summary.upcoming_contract_expirations.length > 0
              ? `${pluralize(summary.upcoming_contract_expirations.length, "contract")} expiring within 90 days`
              : "None expiring within 90 days"
          }
        />
      </LinkedStat>
      <LinkedStat href="/rights/conflicts" action="view conflicts">
        <StatCard
          label="Open rights conflicts"
          icon={<AlertTriangle aria-hidden />}
          value={formatCount(conflicts.total)}
          hint={
            conflicts.total > 0 ? (
              <span className="flex flex-wrap gap-1">
                {SEVERITY_ORDER.filter((severity) => (conflicts.by_severity[severity] ?? 0) > 0).map((severity) => (
                  <Badge key={severity} tone={severityTone(severity)} dot>
                    {conflicts.by_severity[severity]} {severity}
                  </Badge>
                ))}
              </span>
            ) : (
              "No open or acknowledged conflicts"
            )
          }
        />
      </LinkedStat>
    </div>
  );
}

export function isNewOrganization(summary: DashboardSummary): boolean {
  const { catalog } = summary;
  return (
    catalog.works + catalog.recordings + catalog.releases + catalog.parties === 0 &&
    summary.recent_statements.length === 0 &&
    summary.active_contracts === 0
  );
}

/** Onboarding checklist for organizations with no data yet. Steps reflect real counts. */
export function OnboardingCard({ summary, canEdit }: { summary: DashboardSummary; canEdit: boolean }) {
  const steps = [
    {
      done: summary.catalog.works > 0,
      title: "Add works",
      description: "Create compositions with writers and identifiers, or bulk-import a catalog spreadsheet.",
      href: "/catalog/works",
      cta: "Add works",
    },
    {
      done: summary.catalog.recordings > 0,
      title: "Add recordings",
      description: "Link masters (ISRC) to their works so royalties can be matched.",
      href: "/catalog/recordings",
      cta: "Add recordings",
    },
    {
      done: summary.recent_statements.length > 0,
      title: "Import your first statement",
      description: "Upload a DSP, distributor or PRO statement — or record manual income — to populate royalty charts.",
      href: "/royalties/statements",
      cta: "Import a statement",
    },
    {
      done: summary.active_contracts > 0,
      title: "Record a contract",
      description: "Track agreement terms and get warned before contracts expire.",
      href: "/contracts",
      cta: "Add a contract",
    },
  ];
  const completed = steps.filter((step) => step.done).length;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border bg-primary-soft/40 px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">Set up your workspace</h2>
        <p className="text-[13px] text-fg-muted">
          This dashboard only shows figures computed from your own data. {completed} of {steps.length} steps done.
          {canEdit ? "" : " Ask a manager to add data — your role is read-only."}
        </p>
      </div>
      <ol className="grid divide-y divide-border md:grid-cols-2 md:divide-y-0 xl:grid-cols-4 xl:divide-x">
        {steps.map((step, index) => (
          <li key={step.title} className={cn("flex flex-col gap-2 px-5 py-4", index >= 2 && "md:border-t md:border-border xl:border-t-0")}>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                  step.done ? "bg-success-soft text-success-soft-fg" : "bg-surface-2 text-fg-muted",
                )}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <p className="text-sm font-semibold text-fg">
                {step.title}
                {step.done ? <span className="sr-only"> (done)</span> : null}
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-fg-muted">{step.description}</p>
            {!step.done && canEdit ? (
              <Link href={step.href} className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                {step.cta} <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
