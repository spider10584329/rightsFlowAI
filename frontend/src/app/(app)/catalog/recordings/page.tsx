import type { Metadata } from "next";
import { Suspense } from "react";

import { RecordingsListClient } from "@/components/catalog/catalog-list-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Recordings" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RecordingsListClient />
    </Suspense>
  );
}
