import type { Metadata } from "next";
import { Suspense } from "react";

import { ReleasesListClient } from "@/components/catalog/catalog-list-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Releases" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReleasesListClient />
    </Suspense>
  );
}
