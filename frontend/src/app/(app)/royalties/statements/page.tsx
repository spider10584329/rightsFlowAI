import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { StatementsClient } from "./statements-client";

export const metadata: Metadata = { title: "Statements" };

export default function StatementsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StatementsClient />
    </Suspense>
  );
}
