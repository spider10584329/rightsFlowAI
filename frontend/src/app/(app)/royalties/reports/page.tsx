import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ReportsClient } from "./reports-client";

export const metadata: Metadata = { title: "Royalty reports" };

export default function ReportsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportsClient />
    </Suspense>
  );
}
