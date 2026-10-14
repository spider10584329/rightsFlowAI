import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { SplitSheetsClient } from "./split-sheets-client";

export const metadata: Metadata = { title: "Split sheets" };

export default function SplitSheetsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SplitSheetsClient />
    </Suspense>
  );
}
