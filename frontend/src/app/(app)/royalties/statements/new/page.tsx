import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/skeleton";

import { UploadWizardClient } from "./upload-wizard-client";

export const metadata: Metadata = { title: "Upload statement" };

export default function UploadStatementPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <UploadWizardClient />
    </Suspense>
  );
}
