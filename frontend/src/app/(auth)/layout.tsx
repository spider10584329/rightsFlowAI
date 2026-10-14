import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";

const POINTS = [
  "Catalog, rights and contracts in one ledger-grade system",
  "Statement ingestion with matching you can audit line by line",
  "Splits, recoupment and payouts with four-eyes approvals",
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-[#0b0d1a] text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(40rem_28rem_at_10%_0%,rgba(99,102,241,0.35),transparent),radial-gradient(30rem_24rem_at_100%_100%,rgba(20,184,166,0.22),transparent)]" />
        <div aria-hidden className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,#fff_1px,transparent_1px),linear-gradient(to_bottom,#fff_1px,transparent_1px)] [background-size:44px_44px]" />
        <Link href="/" className="relative w-fit rounded-md focus-visible:outline-2 focus-visible:outline-white">
          <Logo inverted />
        </Link>
        <div className="relative max-w-md space-y-8">
          <blockquote className="space-y-4">
            <p className="text-[26px] font-semibold leading-snug tracking-tight">
              Every play, every share, every cent — accounted for.
            </p>
            <p className="text-sm leading-relaxed text-white/70">
              RightsFlow AI gives publishers, labels and administrators one source of truth from registration to royalty payout.
            </p>
          </blockquote>
          <ul className="space-y-3">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm text-white/85">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal-300" aria-hidden />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">Secure by design: httpOnly sessions, CSRF protection and full audit trails.</p>
      </aside>
      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="lg:hidden">
          <Link href="/" className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-ring">
            <Logo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[25rem]">{children}</div>
        </div>
        <p className="text-center text-xs text-fg-subtle">
          <Link href="/pricing" className="hover:text-fg">
            Plans
          </Link>
          <span className="mx-2" aria-hidden>
            ·
          </span>
          <Link href="/features" className="hover:text-fg">
            Features
          </Link>
        </p>
      </main>
    </div>
  );
}
