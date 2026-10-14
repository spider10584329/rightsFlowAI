import { ArrowLeft, Compass } from "lucide-react";
import type { Metadata } from "next";

import { Logo } from "@/components/brand/logo";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-bg px-6 py-16">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" aria-hidden />
      <div className="relative flex max-w-md flex-col items-center text-center">
        <Logo className="mb-10" />
        <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-border bg-surface text-primary shadow-sm">
          <Compass className="size-6" aria-hidden />
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">This page isn&apos;t here</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          The page may have moved, or this part of RightsFlow hasn&apos;t been released to your workspace yet.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/dashboard" leftIcon={<ArrowLeft aria-hidden />}>
            Back to the app
          </ButtonLink>
          <ButtonLink href="/" variant="outline">
            Home
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
