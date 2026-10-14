import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { AiClient } from "./ai-client";

export const metadata: Metadata = { title: "AI assistant" };

export default function AiPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AiClient />
    </Suspense>
  );
}
