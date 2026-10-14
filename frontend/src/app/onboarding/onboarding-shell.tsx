"use client";

import { Suspense, type ReactNode } from "react";

import { UserMenu } from "@/components/app-shell/user-menu";
import { Logo } from "@/components/brand/logo";
import { SessionProvider } from "@/components/session/session-provider";
import { Skeleton } from "@/components/ui/skeleton";

/** Minimal chrome for signed-in users who may not belong to an organization yet. */
export function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <div className="relative min-h-dvh overflow-hidden bg-bg">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(60rem_24rem_at_50%_-6rem,var(--hero-glow),transparent)]"
        />
        <header className="relative flex h-16 items-center justify-between px-5 sm:px-8">
          <Logo />
          <Suspense fallback={<Skeleton className="size-9 rounded-full" />}>
            <UserMenu showNotificationsLink={false} />
          </Suspense>
        </header>
        <main className="relative mx-auto w-full max-w-3xl px-4 pb-20 pt-6 sm:px-6">{children}</main>
      </div>
    </SessionProvider>
  );
}
