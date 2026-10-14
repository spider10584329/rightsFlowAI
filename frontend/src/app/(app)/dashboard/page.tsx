import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { DashboardClient } from "./dashboard-client";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={8} />}>
      <DashboardClient />
    </Suspense>
  );
}
