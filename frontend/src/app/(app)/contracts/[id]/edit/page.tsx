import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { EditContractClient } from "./edit-contract-client";

export const metadata: Metadata = { title: "Edit contract" };

export default function EditContractPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EditContractClient />
    </Suspense>
  );
}
