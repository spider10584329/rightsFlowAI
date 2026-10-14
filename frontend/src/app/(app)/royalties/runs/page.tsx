import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { RunsClient } from "./runs-client";

export const metadata: Metadata = { title: "Processing" };

export default function RunsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RunsClient />
    </Suspense>
  );
}
