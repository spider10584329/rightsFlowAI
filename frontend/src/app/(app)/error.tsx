"use client";

import { useEffect } from "react";

import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";

/** Error boundary for pages inside the app shell (the chrome stays usable). */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <ErrorState error={error} onRetry={retry} />
    </Card>
  );
}
