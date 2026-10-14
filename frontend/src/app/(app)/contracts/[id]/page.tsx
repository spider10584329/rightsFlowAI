import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ContractDetailClient } from "./contract-detail-client";

export const metadata: Metadata = { title: "Contract" };

export default function ContractDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ContractDetailClient />
    </Suspense>
  );
}
