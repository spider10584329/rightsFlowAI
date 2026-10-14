import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { PayoutsClient } from "./payouts-client";

export const metadata: Metadata = { title: "Payouts" };

export default function PayoutsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PayoutsClient />
    </Suspense>
  );
}
