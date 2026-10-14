import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { RightsClient } from "./rights-client";

export const metadata: Metadata = { title: "Rights ownership" };

export default function RightsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RightsClient />
    </Suspense>
  );
}
