"use client";

import { useEffect } from "react";

import { Logo } from "@/components/brand/logo";
import { ErrorState } from "@/components/ui/error-state";

/** Root error boundary (pages outside the authenticated shell). */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg px-6 py-16">
      <Logo />
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-sm">
        <ErrorState error={error} onRetry={retry} />
      </div>
    </main>
  );
}
