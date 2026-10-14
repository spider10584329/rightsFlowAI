import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { StatementDetailClient } from "./statement-detail-client";

export const metadata: Metadata = { title: "Statement" };

export default function StatementDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StatementDetailClient />
    </Suspense>
  );
}
