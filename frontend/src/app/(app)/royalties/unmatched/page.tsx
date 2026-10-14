import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { UnmatchedClient } from "./unmatched-client";

export const metadata: Metadata = { title: "Unmatched transactions" };

export default function UnmatchedPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <UnmatchedClient />
    </Suspense>
  );
}
