import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { NotificationsClient } from "./notifications-client";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NotificationsClient />
    </Suspense>
  );
}
