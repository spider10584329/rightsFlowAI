"use client";

import { ArrowLeft, SearchX } from "lucide-react";

import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader, type Breadcrumb } from "@/components/ui/page-header";
import { isApiError } from "@/lib/api/errors";

export type DetailLoadFailure = "not-found" | "error";

/**
 * Why a detail query finished without data: a 404 (or no error at all, e.g.
 * a missing id) means the record isn't there; anything else is a real
 * failure worth retrying.
 */
export function detailLoadFailure(error: unknown): DetailLoadFailure {
  return !error || (isApiError(error) && error.isNotFound) ? "not-found" : "error";
}

export interface DetailLoadErrorProps {
  error: unknown;
  /** Singular record name, e.g. "Payout batch". */
  noun: string;
  /** Breadcrumbs up to (not including) the record itself. */
  breadcrumbs: Breadcrumb[];
  backHref: string;
  backLabel: string;
  onRetry: () => void;
}

/** Full-page replacement for a detail page whose record could not be loaded, with its own `h1`. */
export function DetailLoadError({ error, noun, breadcrumbs, backHref, backLabel, onRetry }: DetailLoadErrorProps) {
  const notFound = detailLoadFailure(error) === "not-found";
  return (
    <>
      <PageHeader title={notFound ? `${noun} not found` : noun} breadcrumbs={[...breadcrumbs, { label: notFound ? "Not found" : "Error" }]} />
      <Card>
        {notFound ? (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title={`No ${noun.toLowerCase()} at this address`}
            description="It may have been deleted, or it belongs to another organization."
            action={
              <ButtonLink href={backHref} variant="outline" size="sm" leftIcon={<ArrowLeft aria-hidden />}>
                {backLabel}
              </ButtonLink>
            }
          />
        ) : (
          <ErrorState error={error} onRetry={onRetry} />
        )}
      </Card>
    </>
  );
}
