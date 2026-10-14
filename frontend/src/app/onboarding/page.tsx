import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { OnboardingClient } from "./onboarding-client";

export const metadata: Metadata = { title: "Set up your workspace" };

export default function OnboardingPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <OnboardingClient />
    </Suspense>
  );
}
