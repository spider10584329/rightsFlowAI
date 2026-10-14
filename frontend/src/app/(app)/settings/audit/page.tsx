import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { AuditClient } from "./audit-client";

export const metadata: Metadata = { title: "Audit log" };

export default function AuditPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditClient />
    </Suspense>
  );
}
