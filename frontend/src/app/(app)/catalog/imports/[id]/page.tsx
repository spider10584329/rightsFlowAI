import type { Metadata } from "next";
import { Suspense } from "react";

import { ImportJobClient } from "@/components/catalog/import-wizard";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Import job" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ImportJobClient />
    </Suspense>
  );
}
