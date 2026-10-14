import type { Metadata } from "next";
import { Suspense } from "react";

import { ImportWizardClient } from "@/components/catalog/import-wizard";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Import catalog" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ImportWizardClient />
    </Suspense>
  );
}
