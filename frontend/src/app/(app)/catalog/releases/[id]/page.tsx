import type { Metadata } from "next";
import { Suspense } from "react";

import { ReleaseDetailClient } from "@/components/catalog/entity-detail-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Release" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReleaseDetailClient />
    </Suspense>
  );
}
