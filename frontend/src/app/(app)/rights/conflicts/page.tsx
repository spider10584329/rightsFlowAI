import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ConflictsClient } from "./conflicts-client";

export const metadata: Metadata = { title: "Rights conflicts" };

export default function ConflictsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConflictsClient />
    </Suspense>
  );
}
