"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useShareAction, type ShareMutationResult, type ShareRole } from "@/lib/api/hooks/rights";

import { PartyPicker, type PickedRef } from "./pickers";
import { formatPercent, parsePercent, roleLabel, SHARE_ROLE_LABELS, SHARE_ROLES, trimPercent } from "./rights-format";
import { scopeError } from "./territory-scope";
import { TerritorySelect } from "./territory-select";

/** The share fields the actions need (works for ShareResponse and OwnershipShareLine). */
export interface ShareRef {
  id: string;
  party_id: string;
  party_name?: string | null;
  role: string;
  share_percent: string;
  territories: string[];
  excluded_territories?: string[] | null;
  effective_from?: string | null;
  effective_to?: string | null;
  is_controlled: boolean;
  rights_type?: string;
  verification_status?: string;
}

export type ShareActionKind = "verify" | "dispute" | "archive" | "supersede";
export type ShareActionTarget = { kind: ShareActionKind; share: ShareRef } | null;

function describe(share: ShareRef) {
  return `${share.party_name ?? "Party"} · ${roleLabel(share.role)} · ${formatPercent(share.share_percent)}`;
}

function announce(result: ShareMutationResult, message: string) {
  const issues = result.validation.issues.length;
  const conflicts = result.conflicts.length;
  if (issues > 0 || conflicts > 0) {
    toast.warning(message, {
      description: `${issues} validation ${issues === 1 ? "issue" : "issues"} and ${conflicts} open ${conflicts === 1 ? "conflict" : "conflicts"} on this asset. Review the ownership view.`,
    });
  } else {
    toast.success(message);
  }
}

export function ShareActionDialogs({ orgId, target, onClose }: { orgId: string; target: ShareActionTarget; onClose: () => void }) {
  const action = useShareAction(orgId);
  const [notes, setNotes] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const key = target ? `${target.kind}:${target.share.id}` : null;
  if (key !== targetId) {
    setTargetId(key);
    setNotes("");
  }
  const share = target?.share;

  return (
    <>
      <ConfirmDialog
        open={target?.kind === "verify"}
        onOpenChange={(open) => !open && onClose()}
        tone="primary"
        title="Verify share?"
        description={share ? `Mark ${describe(share)} as verified. Verified shares can only change through a superseding share.` : undefined}
        confirmLabel="Verify share"
        onConfirm={async () => {
          if (!share) return;
          const result = await action.mutateAsync({ action: "verify", shareId: share.id, notes: notes.trim() || null });
          announce(result, "Share verified");
        }}
      >
        <FormField label="Verification notes" hint="Optional, e.g. the document you checked against.">
          <Textarea rows={2} value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
      </ConfirmDialog>

      <DisputeDialog
        open={target?.kind === "dispute"}
        share={share ?? null}
        onClose={onClose}
        onSubmit={async (reason) => {
          if (!share) return;
          const result = await action.mutateAsync({ action: "dispute", shareId: share.id, reason });
          announce(result, "Share marked as disputed");
        }}
      />

      <ConfirmDialog
        open={target?.kind === "archive"}
        onOpenChange={(open) => !open && onClose()}
        title="Archive share?"
        description={
          share
            ? `${describe(share)} stops counting toward ownership. Shares are never hard-deleted; the record stays in the rights history.`
            : undefined
        }
        confirmLabel="Archive share"
        onConfirm={async () => {
          if (!share) return;
          const result = await action.mutateAsync({ action: "archive", shareId: share.id });
          announce(result, "Share archived");
        }}
      />

      {target?.kind === "supersede" ? <SupersedeDialog orgId={orgId} share={target.share} onClose={onClose} /> : null}
    </>
  );
}

function DisputeDialog({
  open,
  share,
  onClose,
  onSubmit,
}: {
  open: boolean;
  share: ShareRef | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const close = () => {
    if (pending) return;
    setReason("");
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!reason.trim()) {
      setError("Explain why this share is disputed.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setReason("");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Dispute share"
      description={share ? `Flag ${describe(share)} as disputed. It keeps counting toward totals and is reported as a conflict until resolved.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={pending}>
            Mark as disputed
          </Button>
        </>
      }
    >
      <FormField label="Reason" required error={error ?? undefined}>
        <Textarea rows={3} value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} autoFocus />
      </FormField>
    </Dialog>
  );
}

function SupersedeDialog({ orgId, share, onClose }: { orgId: string; share: ShareRef; onClose: () => void }) {
  const action = useShareAction(orgId);
  const [party, setParty] = useState<PickedRef | null>({ id: share.party_id, label: share.party_name ?? share.party_id });
  const [role, setRole] = useState<ShareRole>(share.role as ShareRole);
  const [percent, setPercent] = useState(trimPercent(share.share_percent));
  const [territories, setTerritories] = useState<string[]>(share.territories.length ? share.territories : ["WORLD"]);
  const [excluded, setExcluded] = useState<string[]>(share.excluded_territories ?? []);
  const [from, setFrom] = useState(share.effective_from ?? "");
  const [to, setTo] = useState(share.effective_to ?? "");
  const [controlled, setControlled] = useState(share.is_controlled);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    const next: Record<string, string> = {};
    const parsed = parsePercent(percent);
    if (!party) next.party_id = "Select a party.";
    if (parsed === null || parsed <= BigInt(0) || parsed > BigInt(100_000_000)) next.share_percent = "Enter a percentage above 0 and up to 100 (max 6 decimals).";
    const territoryError = scopeError({ territories, excluded });
    if (territoryError) next.territories = territoryError;
    if (from && to && to < from) next.effective_to = "End date must be on or after the start date.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    action.mutate(
      {
        action: "supersede",
        shareId: share.id,
        body: {
          party_id: party!.id,
          role,
          share_percent: percent.trim(),
          territories,
          excluded_territories: excluded.length ? excluded : null,
          effective_from: from || null,
          effective_to: to || null,
          is_controlled: controlled,
          reason: reason.trim() || null,
        },
      },
      {
        onSuccess: (result) => {
          announce(result, "Share superseded");
          onClose();
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields);
          if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
        },
      },
    );
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title="Supersede share"
      description={`Creates a new share that replaces ${describe(share)}. The current share is kept as “superseded” in the history.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={action.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={action.isPending}>
            Create superseding share
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {formError ? (
          <Alert tone="danger" className="sm:col-span-2">
            {formError}
          </Alert>
        ) : null}
        <FormField label="Party" required error={errors.party_id} className="sm:col-span-2">
          {(props) => <PartyPicker {...props} orgId={orgId} value={party} onChange={setParty} />}
        </FormField>
        <FormField label="Role" required error={errors.role}>
          {(props) => <Select {...props} value={role} onValueChange={setRole} options={SHARE_ROLES.map((value) => ({ value, label: SHARE_ROLE_LABELS[value] }))} />}
        </FormField>
        <FormField label="Share %" required error={errors.share_percent}>
          <Input inputMode="decimal" value={percent} onChange={(event) => setPercent(event.target.value)} />
        </FormField>
        <FormField label="Territories" required error={errors.territories ?? errors.excluded_territories} className="sm:col-span-2">
          {(props) => (
            <TerritorySelect {...props} value={territories} onChange={setTerritories} excluded={excluded} onExcludedChange={setExcluded} />
          )}
        </FormField>
        <FormField label="Effective from" error={errors.effective_from}>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </FormField>
        <FormField label="Effective to" error={errors.effective_to}>
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </FormField>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch id="supersede-controlled" checked={controlled} onCheckedChange={setControlled} />
          <Label htmlFor="supersede-controlled" className="font-normal">
            Controlled by this organization
          </Label>
        </div>
        <FormField label="Reason" hint="Recorded in the rights history." className="sm:col-span-2" error={errors.reason}>
          <Textarea rows={2} value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
