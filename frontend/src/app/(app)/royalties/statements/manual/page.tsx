import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ManualStatementClient } from "./manual-statement-client";

export const metadata: Metadata = { title: "Manual statement" };

export default function ManualStatementPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ManualStatementClient />
    </Suspense>
  );
}
