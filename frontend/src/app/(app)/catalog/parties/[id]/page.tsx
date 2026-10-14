import type { Metadata } from "next";
import { Suspense } from "react";

import { PartyDetailClient } from "@/components/catalog/entity-detail-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Party" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PartyDetailClient />
    </Suspense>
  );
}
