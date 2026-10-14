import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { NewContractClient } from "./new-contract-client";

export const metadata: Metadata = { title: "New contract" };

export default function NewContractPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewContractClient />
    </Suspense>
  );
}
