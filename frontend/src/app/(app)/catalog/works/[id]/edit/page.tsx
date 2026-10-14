import type { Metadata } from "next";
import { Suspense } from "react";

import { EditEntityClient } from "@/components/catalog/entity-form-page";
import { PageSkeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Edit work" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EditEntityClient entity="work" />
    </Suspense>
  );
}
