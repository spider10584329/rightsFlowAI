import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { PayeeDetailClient } from "./payee-detail-client";

export const metadata: Metadata = { title: "Payee" };

export default function PayeeDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PayeeDetailClient />
    </Suspense>
  );
}
