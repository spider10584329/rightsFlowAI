import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { BatchDetailClient } from "./batch-detail-client";

export const metadata: Metadata = { title: "Payout batch" };

export default function PayoutBatchPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BatchDetailClient />
    </Suspense>
  );
}
