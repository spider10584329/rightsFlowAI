"use client";

import { AlertOctagon, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  compact?: boolean;
}

/** Shows the error message, the backend request id (for support) and a retry action. */
export function ErrorState({ error, title, onRetry, retrying, className, compact }: ErrorStateProps) {
  const requestId = isApiError(error) ? error.requestId : null;
  const digest =
    error && typeof error === "object" && "digest" in error && typeof (error as { digest?: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : null;
  const heading =
    title ??
    (isApiError(error) && error.isForbidden
      ? "You don't have access to this"
      : isApiError(error) && error.isNetwork
        ? "Can't reach RightsFlow"
        : "Something went wrong");

  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      <div className="flex size-11 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <AlertOctagon className="size-5" aria-hidden />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-semibold text-fg">{heading}</p>
        <p className="text-[13px] leading-relaxed text-fg-muted">{errorMessage(error)}</p>
        {requestId || digest ? (
          <p className="pt-1 text-2xs text-fg-subtle">
            {requestId ? "Request ID" : "Error digest"}:{" "}
            <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg-muted">{requestId ?? digest}</code>
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} loading={retrying} leftIcon={<RotateCw aria-hidden />}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
