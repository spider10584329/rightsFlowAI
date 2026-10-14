import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { AutomationClient } from "./automation-client";

export const metadata: Metadata = { title: "Automation" };

export default function AutomationPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AutomationClient />
    </Suspense>
  );
}
