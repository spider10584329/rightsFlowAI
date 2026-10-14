import {
  ArrowRight,
  BookOpenCheck,
  Building2,
  Calculator,
  FileSearch,
  FileSignature,
  Fingerprint,
  Landmark,
  Library,
  Mic2,
  Scale,
  ShieldCheck,
  Sparkles,
  Split,
  Upload,
  Wallet,
} from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: { absolute: "RightsFlow AI — Music rights, publishing administration & royalty accounting" },
  description:
    "One system for catalog, ownership, contracts, statement processing, royalty calculation and payouts. Built for publishers, labels and rights administrators.",
};

const PIPELINE = [
  { icon: Upload, label: "Ingest", detail: "DSP, PRO & distributor statements" },
  { icon: FileSearch, label: "Match", detail: "ISRC, ISWC, title & artist" },
  { icon: Split, label: "Allocate", detail: "Splits, territories, rights types" },
  { icon: Calculator, label: "Account", detail: "Recoupment & immutable ledger" },
  { icon: Wallet, label: "Pay", detail: "Approved, auditable payouts" },
];

const AUDIENCES = [
  {
    icon: BookOpenCheck,
    title: "Music publishers",
    body: "Register works with writers, shares and territories, resolve ownership conflicts and turn performance and mechanical income into accurate writer statements.",
  },
  {
    icon: Mic2,
    title: "Record labels",
    body: "Link recordings and releases to artist agreements, apply recoupment and reserves, and send artists statements they can actually reconcile.",
  },
  {
    icon: Building2,
    title: "Rights administrators",
    body: "Run many clients from one login with strict tenant isolation, role-based access and a full audit trail of every change and approval.",
  },
];

const FEATURES: { icon: typeof Library; title: string; body: string }[] = [
  { icon: Library, title: "Catalog & identifiers", body: "Works, recordings, releases and parties with ISWC, ISRC, UPC and IPI validation." },
  { icon: Scale, title: "Rights & conflicts", body: "Ownership by territory and rights type, with automatic detection of over-claimed shares." },
  { icon: FileSignature, title: "Contracts", body: "Royalty rates, advances, terms and expiry warnings tied directly to the catalog they govern." },
  { icon: FileSearch, title: "Statement processing", body: "Import statements, normalize lines and match them to your catalog with explainable rules." },
  { icon: Calculator, title: "Royalty engine", body: "Decimal-precise calculation runs, splits and recoupment posted to an append-only ledger." },
  { icon: Landmark, title: "Payouts", body: "Payee balances, thresholds and four-eyes approval before money leaves the building." },
  { icon: Sparkles, title: "AI assistance", body: "Contract extraction and matching suggestions that never change data without human approval." },
  { icon: Fingerprint, title: "Audit & security", body: "httpOnly sessions, CSRF protection, granular roles and an immutable activity log." },
];

const STEPS = [
  { title: "Set up your organization", body: "Invite your team with owner, admin, manager or viewer roles." },
  { title: "Load your catalog", body: "Add works, recordings and releases with their identifiers and contributors." },
  { title: "Record who owns what", body: "Capture splits, territories and contract terms; RightsFlow flags conflicts." },
  { title: "Import statements", body: "Upload income statements; lines are matched to your catalog and queued for review." },
  { title: "Run, approve and pay", body: "Calculate royalties, review the results, post to the ledger and approve payouts." },
];

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: ReactNode; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg sm:text-[2.1rem]">{title}</h2>
      {body ? <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">{body}</p> : null}
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_26rem_at_20%_-10%,var(--hero-glow),transparent),radial-gradient(40rem_22rem_at_90%_10%,var(--hero-glow-2),transparent)]"
        />
        <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-14 px-5 pb-20 pt-16 sm:pt-24 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3 py-1 text-xs font-medium text-fg-muted shadow-xs backdrop-blur">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              Rights management · Publishing administration · Royalty accounting
            </p>
            <h1 className="mt-6 text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-fg sm:text-[3.4rem]">
              From first registration
              <br />
              <span className="bg-gradient-to-r from-[#6366f1] via-[#7c3aed] to-[#0d9488] bg-clip-text text-transparent">to final payout.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              RightsFlow AI keeps your catalog, ownership, contracts and royalty accounting in one auditable system — so every
              statement you send reconciles to the cent.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <ButtonLink href="/register" size="lg" rightIcon={<ArrowRight aria-hidden />}>
                Create your workspace
              </ButtonLink>
              <ButtonLink href="/features" size="lg" variant="outline">
                Explore the platform
              </ButtonLink>
            </div>
          </div>

          {/* Pipeline visual */}
          <div className="relative">
            <div className="rounded-2xl border border-border bg-surface/90 p-5 shadow-lg backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-[13px] font-semibold text-fg">Royalty pipeline</p>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-soft-fg">End-to-end</span>
              </div>
              <ol className="relative space-y-2.5">
                <span aria-hidden className="absolute bottom-6 left-[1.35rem] top-6 w-px bg-gradient-to-b from-primary via-[#7c3aed] to-accent opacity-50" />
                {PIPELINE.map((step, index) => (
                  <li key={step.label} className="relative flex items-center gap-4 rounded-xl border border-border bg-bg/60 px-3 py-3">
                    <span className="relative z-10 flex size-[1.9rem] shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-fg">
                      <step.icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-fg">{step.label}</p>
                      <p className="truncate text-xs text-fg-muted">{step.detail}</p>
                    </div>
                    <span className="font-mono text-2xs text-fg-subtle">0{index + 1}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-4 flex items-center gap-2 text-xs text-fg-subtle">
                <ShieldCheck className="size-3.5 text-success" aria-hidden />
                Every step is permissioned and written to the audit log.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Audiences */}
      <section className="border-y border-border bg-surface py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading
            eyebrow="Who it's for"
            title="Built for the people who make the money add up"
            body="Whether you administer one catalog or hundreds, RightsFlow models the music business as it really works."
          />
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {AUDIENCES.map((audience) => (
              <article key={audience.title} className="rounded-2xl border border-border bg-bg p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-sm">
                  <audience.icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight text-fg">{audience.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fg-muted">{audience.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading eyebrow="Platform" title="Everything between the work and the wire transfer" />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="bg-surface p-6 transition-colors hover:bg-surface-2/60">
                <feature.icon className="size-5 text-primary" aria-hidden />
                <h3 className="mt-4 text-[15px] font-semibold text-fg">{feature.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{feature.body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 text-center">
            <ButtonLink href="/features" variant="link" rightIcon={<ArrowRight aria-hidden />}>
              See every capability
            </ButtonLink>
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className="border-t border-border bg-surface py-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Workflow</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg">A month-end close you can explain line by line</h2>
            <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
              Money values are stored as exact decimals, posted results are immutable, and corrections are recorded as
              adjustments — never silent edits.
            </p>
          </div>
          <ol className="space-y-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-4 rounded-xl border border-border bg-bg p-5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary-soft font-mono text-[13px] font-semibold text-primary-soft-fg">
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold text-fg">{step.title}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* CTA */}
      <section className="px-5 py-20">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-[#0b0d1a] px-8 py-14 text-center text-white sm:px-14">
          <div aria-hidden className="absolute inset-0 bg-[radial-gradient(30rem_18rem_at_0%_0%,rgba(99,102,241,0.45),transparent),radial-gradient(26rem_16rem_at_100%_100%,rgba(20,184,166,0.3),transparent)]" />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight">Bring your catalog and your numbers together</h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-white/75">
              Create an organization, invite your team and start loading your catalog today.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <ButtonLink href="/register" size="lg" className="bg-white text-[#0b0d1a] hover:bg-white/90" rightIcon={<ArrowRight aria-hidden />}>
                Get started
              </ButtonLink>
              <ButtonLink href="/pricing" size="lg" variant="outline" className="border-white/25 bg-transparent text-white hover:bg-white/10">
                View plans
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
