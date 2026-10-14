import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { SplitRulesClient } from "./rules-client";

export const metadata: Metadata = { title: "Split validation rules" };

export default function SplitRulesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SplitRulesClient />
    </Suspense>
  );
}
