import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { OrganizationClient } from "./organization-client";

export const metadata: Metadata = { title: "Organization settings" };

export default function OrganizationSettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OrganizationClient />
    </Suspense>
  );
}
