"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { duplicateConflict } from "@/components/catalog/form-utils";
import { entityHref } from "@/components/catalog/labels";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { CatalogEntityType } from "@/lib/api/hooks/catalog";

export function FormSection({ title, description, children, aside }: { title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card>
      <div className="grid gap-6 p-5 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
          {description ? <p className="text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
          {aside}
        </div>
        <div className="min-w-0 space-y-4">{children}</div>
      </div>
    </Card>
  );
}

export function SubmitBar({ cancelHref, submitLabel, pending, dirtyHint }: { cancelHref: string; submitLabel: string; pending: boolean; dirtyHint?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-col-reverse gap-2 rounded-xl border border-border bg-surface/95 px-4 py-3 shadow-md backdrop-blur sm:flex-row sm:items-center sm:justify-end">
      {dirtyHint ? <p className="text-xs text-fg-subtle sm:mr-auto">{dirtyHint}</p> : null}
      <ButtonLink href={cancelHref} variant="outline">
        Cancel
      </ButtonLink>
      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </div>
  );
}

/**
 * Explains a failed save: duplicate identifier (with "save anyway"),
 * plan limit (with a billing link) or the backend message.
 */
export function SaveErrorAlert({
  error,
  entity,
  onSaveAnyway,
  pending,
  mode,
}: {
  error: unknown;
  entity: CatalogEntityType;
  onSaveAnyway: () => void;
  pending: boolean;
  mode: "create" | "edit";
}) {
  if (!error) return null;
  const duplicate = duplicateConflict(error);
  if (duplicate) {
    return (
      <Alert
        tone="warning"
        title="Possible duplicate"
        action={
          <>
            {duplicate.existingId ? (
              <ButtonLink href={entityHref(entity, duplicate.existingId)} variant="outline" size="sm" target="_blank">
                View existing
              </ButtonLink>
            ) : null}
            <Button size="sm" variant="primary" onClick={onSaveAnyway} loading={pending}>
              {mode === "create" ? "Create anyway" : "Save anyway"}
            </Button>
          </>
        }
      >
        {duplicate.message}
      </Alert>
    );
  }
  if (isApiError(error) && error.code === "plan_limit_exceeded") {
    return (
      <Alert tone="danger" title="Plan limit reached" action={<ButtonLink href="/settings/billing" size="sm" variant="outline">View billing</ButtonLink>}>
        {error.message}
      </Alert>
    );
  }
  if (isApiError(error) && error.isNotFound) {
    return (
      <Alert tone="danger" title="A linked item no longer exists">
        {error.message}. It may have been deleted by someone else — remove it and try again.
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="Could not save">
      {errorMessage(error)}
      {isApiError(error) && error.requestId ? <span className="block pt-1 text-2xs opacity-80">Request ID: {error.requestId}</span> : null}
    </Alert>
  );
}

export function ReadOnlyNotice() {
  return (
    <Alert tone="info" title="View-only access">
      Your role can view the catalog but not change it. Ask an admin for manager access. <Link href="/catalog" className="underline">Back to catalog</Link>
    </Alert>
  );
}
