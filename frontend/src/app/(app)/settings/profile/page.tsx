import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { ProfileClient } from "./profile-client";

export const metadata: Metadata = { title: "Profile & security" };

export default function ProfilePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProfileClient />
    </Suspense>
  );
}
