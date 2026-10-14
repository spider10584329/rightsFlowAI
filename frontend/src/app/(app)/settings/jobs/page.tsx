import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { JobsClient } from "./jobs-client";

export const metadata: Metadata = { title: "Background jobs" };

export default function JobsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <JobsClient />
    </Suspense>
  );
}
