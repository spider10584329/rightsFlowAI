import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { PayeesClient } from "./payees-client";

export const metadata: Metadata = { title: "Payees" };

export default function PayeesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PayeesClient />
    </Suspense>
  );
}
