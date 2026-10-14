import type { Metadata } from "next";
import { Suspense } from "react";

import { WorkDetailClient } from "@/components/catalog/entity-detail-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Work" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkDetailClient />
    </Suspense>
  );
}
