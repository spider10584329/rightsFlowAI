import type { Metadata } from "next";
import { Suspense } from "react";

import { PartiesListClient } from "@/components/catalog/catalog-list-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Artists & contributors" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PartiesListClient />
    </Suspense>
  );
}
