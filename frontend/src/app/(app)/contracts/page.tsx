import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ContractsClient } from "./contracts-client";

export const metadata: Metadata = { title: "Contracts" };

export default function ContractsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ContractsClient />
    </Suspense>
  );
}
