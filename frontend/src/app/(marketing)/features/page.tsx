import {
  ArrowRight,
  Bell,
  Calculator,
  CheckCircle2,
  FileSearch,
  FileSignature,
  Landmark,
  Library,
  Scale,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Features",
  description: "Catalog, rights, contracts, statement processing, royalty accounting, payouts, AI assistance and security in RightsFlow AI.",
};

const MODULES = [
  {
    id: "catalog",
    icon: Library,
    title: "Catalog",
    summary: "A single, de-duplicated source of truth for everything you control.",
    points: [
      "Works, recordings, releases, artists and contributors with their relationships",
      "Identifier validation for ISWC, ISRC, UPC/EAN and IPI numbers",
      "Contributor roles for writers, composers, performers and producers",
      "Bulk actions and search across the whole catalog",
    ],
  },
  {
    id: "rights",
    icon: Scale,
    title: "Rights & ownership",
    summary: "Know exactly who owns what, where, and for which rights.",
    points: [
      "Ownership shares by territory and rights type (performance, mechanical, sync, neighbouring…)",
      "Conflict detection when claimed shares exceed 100%",
      "Split sheets that capture agreed shares before registration",
      "Controlled vs. uncontrolled shares for accurate allocation",
    ],
  },
  {
    id: "contracts",
    icon: FileSignature,
    title: "Contracts",
    summary: "The terms behind every calculation, linked to the catalog they govern.",
    points: [
      "Royalty rates, advances, reserves and recoupment terms",
      "Term, territory and expiry tracking with configurable warnings",
      "Attach signed documents and keep their history",
    ],
  },
  {
    id: "statements",
    icon: FileSearch,
    title: "Statement processing",
    summary: "Turn incoming statements into matched, reviewable income lines.",
    points: [
      "Import statements from DSPs, PROs, societies and distributors",
      "Matching by identifier first, with optional title & artist matching",
      "Unmatched lines queued for review instead of being silently dropped",
      "Background jobs with progress for large files",
    ],
  },
  {
    id: "royalties",
    icon: Calculator,
    title: "Royalty accounting",
    summary: "Calculation you can audit, results you can't accidentally change.",
    points: [
      "Exact decimal arithmetic for money and percentages",
      "Calculation runs reviewed before they post to the ledger",
      "Posted entries are immutable; corrections are new adjustment entries",
      "Statements and reports per payee and period",
    ],
  },
  {
    id: "payouts",
    icon: Landmark,
    title: "Payouts",
    summary: "Controlled movement of money to writers, artists and partners.",
    points: [
      "Payee balances with minimum payout thresholds",
      "Four-eyes approval: preparer and approver must differ (configurable)",
      "Payout batches with a complete approval trail",
    ],
  },
  {
    id: "ai",
    icon: Sparkles,
    title: "AI assistance",
    summary: "Faster data entry without giving up control.",
    points: [
      "Contract term extraction and catalog matching suggestions",
      "Suggestions are stored for review and only applied after human approval",
      "Usage metered against your plan; disabled cleanly when no provider is configured",
    ],
  },
  {
    id: "team",
    icon: Users,
    title: "Teams & organizations",
    summary: "Multi-tenant by design for administrators and their clients.",
    points: [
      "Owner, admin, manager and viewer roles enforced on every request",
      "Invitations with single-use links and expiry",
      "Switch between organizations without signing out",
      "Ownership transfer and archiving protected by password and typed confirmation",
    ],
  },
  {
    id: "security",
    icon: ShieldCheck,
    title: "Security & audit",
    summary: "Controls your auditors will recognise.",
    points: [
      "Tokens kept in httpOnly cookies, rotated automatically, never exposed to scripts",
      "CSRF protection and strict security headers on every page",
      "Session management: see and revoke signed-in devices",
      "Activity log with before/after values for every change",
    ],
  },
  {
    id: "notifications",
    icon: Bell,
    title: "Notifications",
    summary: "The right people hear about what needs attention.",
    points: [
      "In-app notifications for imports, conflicts, approvals and team changes",
      "Unread counts, read/unread state and a full notification center",
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Features</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-fg sm:text-[2.75rem] sm:leading-[1.1]">
            The complete rights and royalty stack, without the spreadsheets
          </h1>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-fg-muted">
            Each module stands on the same catalog, the same permissions and the same audit trail, so data entered once flows
            all the way to the payout.
          </p>
          <nav aria-label="Modules" className="mt-8 flex flex-wrap gap-2">
            {MODULES.map((module) => (
              <a
                key={module.id}
                href={`#${module.id}`}
                className="rounded-full border border-border bg-bg px-3 py-1.5 text-[13px] font-medium text-fg-muted transition-colors hover:border-primary/40 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
              >
                {module.title}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-5 px-5 py-16">
        {MODULES.map((module) => (
          <section
            key={module.id}
            id={module.id}
            aria-labelledby={`${module.id}-title`}
            className="grid scroll-mt-24 gap-6 rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8 md:grid-cols-[0.8fr_1.2fr]"
          >
            <div>
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-fg">
                <module.icon className="size-5" aria-hidden />
              </span>
              <h2 id={`${module.id}-title`} className="mt-4 text-xl font-semibold tracking-tight text-fg">
                {module.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{module.summary}</p>
            </div>
            <ul className="space-y-3">
              {module.points.map((point) => (
                <li key={point} className="flex items-start gap-3 text-sm leading-relaxed text-fg">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  {point}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="border-t border-border bg-surface px-5 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-fg">Ready to see it with your own catalog?</h2>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/register" rightIcon={<ArrowRight aria-hidden />}>
            Create your workspace
          </ButtonLink>
          <ButtonLink href="/pricing" variant="outline">
            Compare plans
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
