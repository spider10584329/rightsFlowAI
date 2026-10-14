import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { ButtonLink } from "@/components/ui/button";

const NAV = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Plans" },
];

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a
        href="#content"
        className="sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
          <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label="RightsFlow AI home">
            <Logo />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ButtonLink href="/login" variant="ghost" size="sm">
              Sign in
            </ButtonLink>
            <ButtonLink href="/register" size="sm">
              Get started
            </ButtonLink>
          </div>
        </div>
      </header>
      <main id="content" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:grid-cols-[1.4fr_1fr_1fr]">
          <div className="space-y-3">
            <Logo />
            <p className="max-w-xs text-[13px] leading-relaxed text-fg-muted">
              Rights management, publishing administration and royalty accounting for the modern music business.
            </p>
          </div>
          <div>
            <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.1em] text-fg-subtle">Product</p>
            <ul className="space-y-2 text-[13px]">
              <li>
                <Link href="/features" className="text-fg-muted hover:text-fg">
                  Features
                </Link>
              </li>
              <li>
                <Link href="/pricing" className="text-fg-muted hover:text-fg">
                  Plans
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.1em] text-fg-subtle">Account</p>
            <ul className="space-y-2 text-[13px]">
              <li>
                <Link href="/login" className="text-fg-muted hover:text-fg">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/register" className="text-fg-muted hover:text-fg">
                  Create account
                </Link>
              </li>
              <li>
                <Link href="/forgot-password" className="text-fg-muted hover:text-fg">
                  Reset password
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-border">
          <p className="mx-auto max-w-6xl px-5 py-5 text-xs text-fg-subtle">RightsFlow AI. Built for rights holders who need every number to reconcile.</p>
        </div>
      </footer>
    </div>
  );
}
