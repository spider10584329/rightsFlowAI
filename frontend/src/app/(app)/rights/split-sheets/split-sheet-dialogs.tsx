"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { TotalStatusBadge } from "@/components/rights/badges";
import { AssetPicker, PartyPicker, type PickedRef } from "@/components/rights/pickers";
import { microToPercentString, parsePercent, SHARE_ROLE_LABELS, SHARE_ROLES, sumPercents, totalStatus, trimPercent, WORK_RIGHTS_TYPES, RIGHTS_TYPE_LABELS } from "@/components/rights/rights-format";
import { scopeError } from "@/components/rights/territory-scope";
import { TerritorySelect } from "@/components/rights/territory-select";
import { ValidationReport } from "@/components/rights/validation-report";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import {
  useApplySplitSheet,
  useCreateSplitSheet,
  useUpdateSplitSheet,
  type RightsValidationIssue,
  type ShareRole,
  type SplitSheet,
  type SplitSheetApplyResult,
} from "@/lib/api/hooks/rights";
import { titleCase } from "@/lib/utils";

export const SHEET_STATUSES = ["draft", "signed", "verified", "disputed"] as const;
type SheetStatus = (typeof SHEET_STATUSES)[number];

interface EntryRow {
  key: string;
  party: PickedRef | null;
  role: ShareRole;
  share_percent: string;
}

let counter = 0;
const key = () => `entry-${(counter += 1)}`;

export function SplitSheetFormDialog({ orgId, sheet, open, onClose }: { orgId: string; sheet: SplitSheet | null; open: boolean; onClose: () => void }) {
  const create = useCreateSplitSheet(orgId);
  const update = useUpdateSplitSheet(orgId);
  const pending = create.isPending || update.isPending;
  const [work, setWork] = useState<PickedRef | null>(sheet ? { id: sheet.work_id, label: sheet.work_title ?? "Work" } : null);
  const [title, setTitle] = useState(sheet?.title ?? "");
  const [agreedDate, setAgreedDate] = useState(sheet?.agreed_date ?? "");
  const [status, setStatus] = useState<SheetStatus>((sheet?.status as SheetStatus) ?? "draft");
  const [notes, setNotes] = useState(sheet?.notes ?? "");
  const [entries, setEntries] = useState<EntryRow[]>(
    sheet
      ? sheet.entries.map((entry) => ({
          key: key(),
          party: { id: entry.party_id, label: entry.party_name ?? entry.party_id },
          role: entry.role as ShareRole,
          share_percent: trimPercent(entry.share_percent),
        }))
      : [{ key: key(), party: null, role: "writer", share_percent: "" }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const { total, invalid } = sumPercents(entries.map((entry) => entry.share_percent));
  const status100 = invalid > 0 ? "invalid" : totalStatus(total, { expectedTotal: "100", tolerance: "0", allowUnderAllocation: false });

  const updateEntry = (rowKey: string, patch: Partial<EntryRow>) => setEntries((list) => list.map((entry) => (entry.key === rowKey ? { ...entry, ...patch } : entry)));

  const submit = () => {
    const next: Record<string, string> = {};
    if (!work) next.work_id = "Select a work.";
    if (!title.trim()) next.title = "Title is required.";
    if (entries.length === 0) next.entries = "Add at least one entry.";
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (!entry.party) next[`party-${index}`] = "Select a party.";
      const parsed = parsePercent(entry.share_percent);
      if (parsed === null || parsed <= BigInt(0) || parsed > BigInt(100_000_000)) next[`percent-${index}`] = "Above 0, at most 100.";
      const dup = `${entry.party?.id}:${entry.role}`;
      if (entry.party && seen.has(dup)) next[`party-${index}`] = "Each party/role may appear only once.";
      seen.add(dup);
    });
    if (status100 === "over") next.entries = "Entries total more than 100%.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    const body = {
      title: title.trim(),
      agreed_date: agreedDate || null,
      status,
      notes: notes.trim() || null,
      entries: entries.map((entry) => ({ party_id: entry.party!.id, role: entry.role, share_percent: entry.share_percent.trim() })),
    };
    const handlers = {
      onSuccess: () => {
        toast.success(sheet ? "Split sheet updated" : "Split sheet created");
        onClose();
      },
      onError: (error: unknown) => {
        const fields = fieldErrors(error);
        setErrors(fields);
        if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
      },
    };
    if (sheet) update.mutate({ id: sheet.id, body }, handlers);
    else create.mutate({ ...body, work_id: work!.id }, handlers);
  };

  return (
    <Dialog
      open={open}
      size="lg"
      onOpenChange={(next) => !next && !pending && onClose()}
      title={sheet ? "Edit split sheet" : "New split sheet"}
      description="A split sheet records the agreed writer/publisher percentages for a work. Apply it to create ownership shares."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {sheet ? "Save changes" : "Create split sheet"}
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
        <FormField label="Work" required error={errors.work_id} className="sm:col-span-2" hint={sheet ? "The work of an existing sheet cannot change." : undefined}>
          {(props) => <AssetPicker {...props} orgId={orgId} assetType="work" value={work} onChange={setWork} disabled={Boolean(sheet)} />}
        </FormField>
        <FormField label="Title" required error={errors.title} className="sm:col-span-2">
          <Input value={title} maxLength={255} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Writing session 12 May" />
        </FormField>
        <FormField label="Agreed date" error={errors.agreed_date}>
          <Input type="date" value={agreedDate} onChange={(event) => setAgreedDate(event.target.value)} />
        </FormField>
        <FormField label="Status" error={errors.status}>
          {(props) => <Select {...props} value={status} onValueChange={setStatus} options={SHEET_STATUSES.map((value) => ({ value, label: titleCase(value) }))} />}
        </FormField>

        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="flex w-full items-center justify-between text-[13px] font-medium">
            <span>Entries</span>
            <span className="flex items-center gap-2 text-xs font-normal text-fg-muted" aria-live="polite">
              Total <span className="font-semibold tabular-nums text-fg">{microToPercentString(total)}%</span>
              <TotalStatusBadge status={status100} />
            </span>
          </legend>
          {errors.entries ? <p className="text-xs font-medium text-danger">{errors.entries}</p> : null}
          <ol className="space-y-2">
            {entries.map((entry, index) => (
              <li key={entry.key} className="grid items-start gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_9rem_6.5rem_auto]">
                <FormField label={`Party ${index + 1}`} error={errors[`party-${index}`]}>
                  {(props) => <PartyPicker {...props} size="sm" orgId={orgId} value={entry.party} onChange={(party) => updateEntry(entry.key, { party })} />}
                </FormField>
                <FormField label="Role">
                  {(props) => (
                    <Select {...props} size="sm" value={entry.role} onValueChange={(role) => updateEntry(entry.key, { role })} options={SHARE_ROLES.map((value) => ({ value, label: SHARE_ROLE_LABELS[value] }))} />
                  )}
                </FormField>
                <FormField label="Share %" error={errors[`percent-${index}`]}>
                  <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={entry.share_percent} onChange={(event) => updateEntry(entry.key, { share_percent: event.target.value })} />
                </FormField>
                <IconButton
                  className="mt-6"
                  label={`Remove entry ${index + 1}`}
                  icon={<Trash2 aria-hidden />}
                  variant="danger"
                  size="sm"
                  disabled={entries.length <= 1}
                  onClick={() => setEntries((list) => list.filter((item) => item.key !== entry.key))}
                />
              </li>
            ))}
          </ol>
          <Button size="sm" variant="outline" leftIcon={<Plus aria-hidden />} onClick={() => setEntries((list) => [...list, { key: key(), party: null, role: "writer", share_percent: "" }])} disabled={entries.length >= 100}>
            Add entry
          </Button>
          {status100 === "under" ? <p className="text-xs text-fg-subtle">Entries total less than 100%. That is allowed on a sheet, but applying it will create under-allocated shares.</p> : null}
        </fieldset>
        <FormField label="Notes" className="sm:col-span-2">
          <Textarea rows={2} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}

export function ApplySheetDialog({ orgId, sheet, onClose }: { orgId: string; sheet: SplitSheet; onClose: () => void }) {
  const apply = useApplySplitSheet(orgId);
  const [rightsTypes, setRightsTypes] = useState<string[]>(["performance", "mechanical"]);
  const [territories, setTerritories] = useState<string[]>(["WORLD"]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"add" | "replace">("replace");
  const partyIds = [...new Set(sheet.entries.map((entry) => entry.party_id))];
  const [controlled, setControlled] = useState<string[]>(partyIds);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<RightsValidationIssue[] | null>(null);
  const [result, setResult] = useState<SplitSheetApplyResult | null>(null);

  const submit = () => {
    const next: Record<string, string> = {};
    if (rightsTypes.length === 0) next.rights_types = "Choose at least one rights type.";
    const territoryError = scopeError({ territories, excluded });
    if (territoryError) next.territories = territoryError;
    if (from && to && to < from) next.effective_to = "Must be on or after the start date.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    setBlocked(null);
    apply.mutate(
      {
        id: sheet.id,
        body: {
          rights_types: rightsTypes as ("performance" | "mechanical" | "sync" | "print")[],
          territories,
          excluded_territories: excluded.length ? excluded : null,
          effective_from: from || null,
          effective_to: to || null,
          mode,
          controlled_party_ids: controlled,
        },
      },
      {
        onSuccess: (data) => {
          setResult(data);
          toast.success("Split sheet applied", { description: `${data.shares.length} shares created · ${data.superseded} superseded · ${data.archived} archived` });
        },
        onError: (error) => {
          if (isApiError(error) && error.code === "split_rule_violation") {
            setBlocked((error.details as { issues?: RightsValidationIssue[] } | null)?.issues ?? []);
            setFormError(error.message);
            return;
          }
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
      onOpenChange={(open) => !open && !apply.isPending && onClose()}
      title={result ? "Split sheet applied" : `Apply “${sheet.title}”`}
      description={result ? undefined : `Creates ownership shares on ${sheet.work_title ?? "the work"} from the sheet's ${sheet.entries.length} entries (source: split sheet).`}
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={apply.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={apply.isPending}>
              Apply to shares
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <p className="text-[13px]">
            {result.shares.length} shares created, {result.superseded} superseded and {result.archived} archived.{" "}
            <Link className="font-medium text-primary hover:underline" href={`/rights?asset_type=work&asset_id=${sheet.work_id}`}>
              Open ownership
            </Link>
          </p>
          <ValidationReport result={result.validation} title="Validation after applying" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {formError ? (
            <Alert tone="danger" className="sm:col-span-2" title={blocked ? "Blocked by a split rule — nothing was applied" : undefined}>
              {formError}
            </Alert>
          ) : null}
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-[13px] font-medium">Rights types</legend>
            <div className="flex flex-wrap gap-4">
              {WORK_RIGHTS_TYPES.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <Checkbox
                    id={`apply-${type}`}
                    checked={rightsTypes.includes(type)}
                    onCheckedChange={(checked) => setRightsTypes((list) => (checked ? [...list, type] : list.filter((item) => item !== type)))}
                  />
                  <Label htmlFor={`apply-${type}`} className="font-normal">
                    {RIGHTS_TYPE_LABELS[type]}
                  </Label>
                </div>
              ))}
            </div>
            {errors.rights_types ? <p className="text-xs font-medium text-danger">{errors.rights_types}</p> : null}
          </fieldset>
          <FormField label="Territories" required error={errors.territories ?? errors.excluded_territories} className="sm:col-span-2">
            {(props) => <TerritorySelect {...props} value={territories} onChange={setTerritories} excluded={excluded} onExcludedChange={setExcluded} />}
          </FormField>
          <FormField label="Effective from" error={errors.effective_from}>
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </FormField>
          <FormField label="Effective to" error={errors.effective_to}>
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </FormField>
          <FormField
            label="Mode"
            className="sm:col-span-2"
            hint={mode === "replace" ? "Replace the active shares of each selected rights type with the sheet's entries." : "Add the entries next to the existing shares."}
          >
            {(props) => (
              <Select
                {...props}
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "replace", label: "Replace existing shares" },
                  { value: "add", label: "Add to existing shares" },
                ]}
              />
            )}
          </FormField>
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-[13px] font-medium">Controlled by this organization</legend>
            <ul className="space-y-1.5">
              {partyIds.map((partyId) => {
                const name = sheet.entries.find((entry) => entry.party_id === partyId)?.party_name ?? partyId;
                return (
                  <li key={partyId} className="flex items-center gap-2">
                    <Checkbox
                      id={`controlled-${partyId}`}
                      checked={controlled.includes(partyId)}
                      onCheckedChange={(checked) => setControlled((list) => (checked ? [...list, partyId] : list.filter((item) => item !== partyId)))}
                    />
                    <Label htmlFor={`controlled-${partyId}`} className="font-normal">
                      {name}
                    </Label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {blocked && blocked.length > 0 ? (
            <div className="sm:col-span-2">
              <ValidationReport result={{ valid: false, blocked: true, issues: blocked, totals: [] }} title="Blocking issues" />
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
