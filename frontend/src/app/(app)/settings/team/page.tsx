import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { TeamClient } from "./team-client";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TeamClient />
    </Suspense>
  );
}
