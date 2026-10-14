import type { Metadata } from "next";
import { Suspense } from "react";

import { NewEntityClient } from "@/components/catalog/entity-form-page";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "New release" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewEntityClient entity="release" />
    </Suspense>
  );
}
