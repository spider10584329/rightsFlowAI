import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { BillingClient } from "./billing-client";

export const metadata: Metadata = { title: "Billing" };

export default function BillingPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BillingClient />
    </Suspense>
  );
}
