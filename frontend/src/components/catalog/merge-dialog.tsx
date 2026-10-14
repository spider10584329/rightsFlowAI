"use client";

import { useState } from "react";

import { ENTITY_LABEL } from "@/components/catalog/labels";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useMergeCatalogItems, type CatalogEntityType, type MergeResult } from "@/lib/api/hooks/catalog";

export interface MergeCandidate {
  id: string;
  title: string;
}

const MOVED_LABELS: Record<string, string> = {
  contributors: "contributors",
  work_contributions: "work credits",
  recording_contributions: "recording credits",
  recording_links: "recording links",
  work_links: "work links",
  contract_links: "contract links",
  contract_parties: "contract party links",
  ownership_shares: "ownership shares",
  split_sheets: "split sheets",
  release_tracks: "release tracks",
  tracks_added: "tracks",
  unposted_statement_lines: "unposted statement lines",
  primary_artist_of: "recordings (primary artist)",
  label_of: "releases (label)",
  royalty_terms: "contract royalty terms",
  payee: "payee profile",
};

/** Human summary of what a merge moved, e.g. "Moved 3 ownership shares and 1 recording link". */
export function describeMerge(result: Pick<MergeResult, "moved" | "filled_fields">): string {
  const parts = Object.entries(result.moved)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${MOVED_LABELS[key] ?? key.replaceAll("_", " ")}`);
  const moved = parts.length ? `Moved ${parts.join(", ")}.` : "No references needed moving.";
  const filled = result.filled_fields.length ? ` Filled ${result.filled_fields.join(", ").replaceAll("_", " ")} from the duplicate.` : "";
  return moved + filled;
}

export function MergeDialog({
  orgId,
  entity,
  candidates,
  open,
  onOpenChange,
}: {
  orgId: string;
  entity: CatalogEntityType;
  candidates: [MergeCandidate, MergeCandidate];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const merge = useMergeCatalogItems(orgId);
  const [survivorId, setSurvivorId] = useState(candidates[0].id);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const survivor = candidates.find((c) => c.id === survivorId) ?? candidates[0];
  const duplicate = candidates.find((c) => c.id !== survivor.id) ?? candidates[1];
  const label = ENTITY_LABEL[entity].singular.toLowerCase();

  const close = (next: boolean) => {
    if (merge.isPending) return;
    if (!next) {
      setConfirmed(false);
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = () => {
    setError(null);
    merge.mutate(
      { entity_type: entity, survivor_id: survivor.id, duplicate_id: duplicate.id },
      {
        onSuccess: (result) => {
          toast.success(`Merged into “${survivor.title}”`, { description: describeMerge(result) });
          close(false);
        },
        onError: (err) => {
          if (isApiError(err) && err.code === "merge_payee_conflict") {
            setError("Both parties have payee profiles with their own ledgers. Settle and deactivate one payee first, then merge.");
          } else {
            setError(errorMessage(err));
          }
        },
      },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader title={`Merge duplicate ${label}`} description="Choose the record to keep. The other is archived and points to it." />
        <DialogBody className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-fg">Keep</legend>
            {candidates.map((candidate) => (
              <label
                key={candidate.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40"
              >
                <input
                  type="radio"
                  name="merge-survivor"
                  value={candidate.id}
                  checked={survivorId === candidate.id}
                  onChange={() => setSurvivorId(candidate.id)}
                  className="size-4 accent-[var(--color-primary)]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{candidate.title}</span>
                  <span className="block truncate font-mono text-2xs text-fg-subtle">{candidate.id}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Alert tone="info" title="What happens">
            Credits, links, ownership shares, contract links and unposted statement lines move from “{duplicate.title}” to “{survivor.title}”.
            Empty fields on the kept record are filled from the duplicate. Posted royalties and ledger history are not changed. The duplicate
            is archived, not deleted.
          </Alert>
          {error ? (
            <Alert tone="danger" title="Merge not possible">
              {error}
            </Alert>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-fg">
            <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} aria-label="Confirm merge" />
            <span>I understand that references move to the kept record and this can&apos;t be undone automatically.</span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={merge.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!confirmed} loading={merge.isPending}>
            Merge into “{survivor.title}”
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
