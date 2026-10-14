import type { Metadata } from "next";
import { Suspense } from "react";

import { CatalogOverviewClient } from "@/components/catalog/catalog-overview";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Catalog" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CatalogOverviewClient />
    </Suspense>
  );
}
