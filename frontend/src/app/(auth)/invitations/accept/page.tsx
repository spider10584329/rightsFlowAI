import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { AcceptInvitation } from "./accept-invitation";

export const metadata: Metadata = { title: "Join an organization" };

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full rounded-xl" />}>
      <AcceptInvitation />
    </Suspense>
  );
}
