"use client";

import { AlertTriangle, Archive, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ENTITY_LABEL, entityHref, referenceLabel } from "@/components/catalog/labels";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useCatalogBulk, useDeleteCatalogItem, type BulkAction, type CatalogBulkResult, type CatalogEntityType } from "@/lib/api/hooks/catalog";
import { pluralize } from "@/lib/utils";

export interface EntityRef {
  id: string;
  title: string;
  status?: string;
}

/** Parses `409 <entity>_in_use` into the blocking reference counts. */
export function referenceBlock(error: unknown): { message: string; references: Record<string, number> } | null {
  if (!isApiError(error) || error.status !== 409 || !error.code.endsWith("_in_use")) return null;
  const details = (error.details ?? {}) as { references?: Record<string, number> };
  return { message: error.message, references: details.references ?? {} };
}

/** Archive or restore one item through the bulk endpoint (audited as archived/restored). */
export function useArchiveToggle(orgId: string, entity: CatalogEntityType) {
  const bulk = useCatalogBulk(orgId);
  const run = (item: EntityRef, action: "archive" | "restore") =>
    bulk.mutateAsync({ entity_type: entity, action, ids: [item.id] }).then(
      (result) => {
        if (result.affected > 0) toast.success(action === "archive" ? `Archived ${item.title}` : `Restored ${item.title}`);
        else toast.warning(`${item.title} was not changed`, { description: result.skipped[0]?.reason });
        return result;
      },
      (error: unknown) => {
        toast.error(action === "archive" ? "Could not archive" : "Could not restore", { description: errorMessage(error) });
        throw error;
      },
    );
  return { run, pending: bulk.isPending };
}

export function DeleteEntityDialog({
  orgId,
  entity,
  item,
  onClose,
  onDeleted,
  canArchive,
}: {
  orgId: string;
  entity: CatalogEntityType;
  item: EntityRef | null;
  onClose: () => void;
  onDeleted?: () => void;
  canArchive: boolean;
}) {
  const remove = useDeleteCatalogItem(orgId, entity);
  const archive = useArchiveToggle(orgId, entity);
  const [error, setError] = useState<unknown>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  if ((item?.id ?? null) !== itemId) {
    setItemId(item?.id ?? null);
    setError(null);
  }
  const label = ENTITY_LABEL[entity].singular.toLowerCase();
  const blocked = referenceBlock(error);
  const busy = remove.isPending || archive.pending;

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => !open && close()}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-danger" aria-hidden /> {blocked ? `Can't delete this ${label}` : `Delete ${label}?`}
        </span>
      }
      description={
        blocked
          ? undefined
          : item
            ? `“${item.title}” will be permanently deleted. Its change history stays in the audit log. This can't be undone.`
            : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={busy}>
            {blocked ? "Close" : "Cancel"}
          </Button>
          {blocked ? (
            canArchive && item && item.status !== "archived" ? (
              <Button
                leftIcon={<Archive aria-hidden />}
                loading={archive.pending}
                onClick={() =>
                  void archive.run(item, "archive").then(() => {
                    onClose();
                  }, () => undefined)
                }
              >
                Archive instead
              </Button>
            ) : null
          ) : (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (!item) return;
                setError(null);
                remove.mutate(item.id, {
                  onSuccess: () => {
                    toast.success(`Deleted ${item.title}`);
                    onClose();
                    onDeleted?.();
                  },
                  onError: setError,
                });
              }}
            >
              Delete permanently
            </Button>
          )}
        </>
      }
    >
      {blocked ? (
        <div className="space-y-3 text-[13px]">
          <p className="text-fg-muted">
            “{item?.title}” is still used by other records, so deleting it would break them. Archive it to hide it from the catalog while keeping the history intact.
          </p>
          {Object.keys(blocked.references).length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Blocking references">
              {Object.entries(blocked.references).map(([key, count]) => (
                <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="flex items-center gap-2 text-fg">
                    <Link2 className="size-3.5 text-fg-subtle" aria-hidden /> {referenceLabel(key)}
                  </span>
                  <span className="font-medium tabular-nums text-fg">{count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">{blocked.message}</p>
          )}
        </div>
      ) : error ? (
        <Alert tone="danger">{errorMessage(error)}</Alert>
      ) : null}
    </Dialog>
  );
}

const ACTION_PAST: Record<BulkAction, string> = { archive: "Archived", restore: "Restored", delete: "Deleted" };

/** Summarises a bulk action, listing every skipped item with its reason. */
export function BulkResultDialog({
  result,
  titles,
  onClose,
}: {
  result: CatalogBulkResult | null;
  titles: Record<string, string>;
  onClose: () => void;
}) {
  const entity = result?.entity_type ?? "work";
  const noun = (count: number) => (entity === "party" ? (count === 1 ? "party" : "parties") : `${ENTITY_LABEL[entity].singular.toLowerCase()}${count === 1 ? "" : "s"}`);
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => !open && onClose()}
      title={result ? (result.affected === 0 ? `No ${noun(0)} ${ACTION_PAST[result.action].toLowerCase()}` : `${ACTION_PAST[result.action]} ${result.affected} ${noun(result.affected)}`) : ""}
      description={result ? `${pluralize(result.skipped.length, "item")} skipped. Review the reasons below.` : undefined}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {result ? (
        <ul className="divide-y divide-border rounded-lg border border-border text-[13px]" aria-label="Skipped items">
          {result.skipped.map((skip) => (
            <li key={skip.id} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              {titles[skip.id] ? (
                <Link href={entityHref(entity, skip.id)} className="font-medium text-fg hover:text-primary hover:underline">
                  {titles[skip.id]}
                </Link>
              ) : (
                <span className="font-mono text-xs text-fg-muted">{skip.id}</span>
              )}
              <span className="text-fg-muted sm:text-right">{skip.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
