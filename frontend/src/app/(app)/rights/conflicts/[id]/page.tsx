import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ConflictDetailClient } from "./conflict-detail-client";

export const metadata: Metadata = { title: "Rights conflict" };

export default function ConflictDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConflictDetailClient />
    </Suspense>
  );
}
