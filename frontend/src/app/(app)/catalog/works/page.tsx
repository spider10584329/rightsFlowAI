import type { Metadata } from "next";
import { Suspense } from "react";

import { WorksListClient } from "@/components/catalog/catalog-list-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Works" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorksListClient />
    </Suspense>
  );
}
