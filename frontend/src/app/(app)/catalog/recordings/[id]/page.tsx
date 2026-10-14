import type { Metadata } from "next";
import { Suspense } from "react";

import { RecordingDetailClient } from "@/components/catalog/entity-detail-pages";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Recording" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RecordingDetailClient />
    </Suspense>
  );
}
