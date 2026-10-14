import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { RunDetailClient } from "./run-detail-client";

export const metadata: Metadata = { title: "Calculation run" };

export default function RunDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RunDetailClient />
    </Suspense>
  );
}
