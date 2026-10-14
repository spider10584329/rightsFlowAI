"use client";

import { CheckCheck, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError, validationIssues } from "@/lib/api/errors";
import { useContract } from "@/lib/api/hooks/contracts";
import {
  useAssetShares,
  useReplaceSplits,
  useSplitRules,
  useValidateShares,
  type AssetType,
  type RightsType,
  type RightsValidationIssue,
  type Share,
  type ShareRole,
  type SplitEntry,
  type ValidationResult,
} from "@/lib/api/hooks/rights";
import { useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";
import { cn } from "@/lib/utils";

import { TotalStatusBadge } from "./badges";
import { ContractPicker, PartyPicker, type PickedRef } from "./pickers";
import {
  parsePercent,
  resolveRule,
  RIGHTS_TYPE_HINTS,
  RIGHTS_TYPE_LABELS,
  rightsTypesFor,
  runningTotal,
  SHARE_ROLE_LABELS,
  SHARE_ROLES,
  trimPercent,
  type EffectiveRule,
} from "./rights-format";
import { scopeError } from "./territory-scope";
import { TerritorySelect } from "./territory-select";
import { IssueList, ValidationReport } from "./validation-report";

export interface SplitRow {
  key: string;
  party: PickedRef | null;
  role: ShareRole;
  share_percent: string;
  territories: string[];
  excluded_territories: string[];
  effective_from: string;
  effective_to: string;
  is_controlled: boolean;
  contract: PickedRef | null;
  notes: string | null;
  /** Existing share this row came from (for display only; the backend matches by party + role). */
  sourceShareId?: string;
  verified?: boolean;
}

let rowCounter = 0;
const nextKey = () => `row-${(rowCounter += 1)}`;

export function emptyRow(): SplitRow {
  return {
    key: nextKey(),
    party: null,
    role: "writer",
    share_percent: "",
    territories: ["WORLD"],
    excluded_territories: [],
    effective_from: "",
    effective_to: "",
    is_controlled: true,
    contract: null,
    notes: null,
  };
}

function rowFromShare(share: Share): SplitRow {
  return {
    key: nextKey(),
    party: { id: share.party_id, label: share.party_name ?? share.party_id },
    role: share.role as ShareRole,
    share_percent: trimPercent(share.share_percent),
    territories: share.territories.length ? share.territories : ["WORLD"],
    excluded_territories: share.excluded_territories ?? [],
    effective_from: share.effective_from ?? "",
    effective_to: share.effective_to ?? "",
    is_controlled: share.is_controlled,
    contract: share.contract_id ? { id: share.contract_id, label: "" } : null,
    notes: share.notes ?? null,
    sourceShareId: share.id,
    verified: share.verification_status === "verified",
  };
}

/** Comparable payload of the editable fields (used for dirty / validated checks). */
export function rowsSignature(rows: SplitRow[]): string {
  return JSON.stringify(
    rows.map((row) => [
      row.party?.id ?? null,
      row.role,
      row.share_percent.trim(),
      row.territories,
      row.excluded_territories,
      row.effective_from || null,
      row.effective_to || null,
      row.is_controlled,
      row.contract?.id ?? null,
    ]),
  );
}

export type RowErrors = Partial<Record<"party" | "share_percent" | "territories" | "effective_to", string>>;

/** Client-side checks mirroring the backend ShareScopeFields validators. */
export function validateRows(rows: SplitRow[]): Record<string, RowErrors> {
  const result: Record<string, RowErrors> = {};
  for (const row of rows) {
    const errors: RowErrors = {};
    if (!row.party) errors.party = "Select a party.";
    const parsed = parsePercent(row.share_percent);
    if (parsed === null) errors.share_percent = "Enter a number with up to 6 decimals.";
    else if (parsed <= BigInt(0) || parsed > BigInt(100_000_000)) errors.share_percent = "Must be above 0 and at most 100.";
    const territoryError = scopeError({ territories: row.territories, excluded: row.excluded_territories });
    if (territoryError) errors.territories = territoryError;
    if (row.effective_from && row.effective_to && row.effective_to < row.effective_from) errors.effective_to = "Must be on or after the start date.";
    if (Object.keys(errors).length > 0) result[row.key] = errors;
  }
  return result;
}

export function toEntry(row: SplitRow): SplitEntry {
  return {
    party_id: row.party?.id ?? "",
    role: row.role,
    share_percent: row.share_percent.trim(),
    territories: row.territories,
    excluded_territories: row.excluded_territories.length ? row.excluded_territories : null,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    is_controlled: row.is_controlled,
    contract_id: row.contract?.id ?? null,
    notes: row.notes,
  };
}

const CLAIM_STATUSES = new Set(["active", "disputed"]);

export function SplitsEditor({ orgId, assetType, assetId, canEdit }: { orgId: string; assetType: AssetType; assetId: string; canEdit: boolean }) {
  const types = rightsTypesFor(assetType);
  const [rightsType, setRightsType] = useState<RightsType>(types[0]);
  const shares = useAssetShares(orgId, assetType, assetId);
  const rules = useSplitRules(orgId);
  const [drafts, setDrafts] = useState<Partial<Record<RightsType, SplitRow[]>>>({});
  const [validation, setValidation] = useState<{ signature: string; rightsType: RightsType; result: ValidationResult } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [serverIssues, setServerIssues] = useState<RightsValidationIssue[] | null>(null);
  const validate = useValidateShares(orgId);

  const serverRows = useMemo(() => {
    const byType: Partial<Record<RightsType, SplitRow[]>> = {};
    for (const share of shares.data ?? []) {
      if (!CLAIM_STATUSES.has(share.status)) continue;
      const key = share.rights_type as RightsType;
      (byType[key] ??= []).push(rowFromShare(share));
    }
    return byType;
  }, [shares.data]);

  const baseline = serverRows[rightsType] ?? [];
  const rows = drafts[rightsType] ?? baseline;
  const dirty = drafts[rightsType] !== undefined && rowsSignature(drafts[rightsType]!) !== rowsSignature(baseline);
  // Unsaved edits in any rights type, not just the one on screen.
  useUnsavedChangesWarning(types.some((type) => drafts[type] !== undefined && rowsSignature(drafts[type]!) !== rowsSignature(serverRows[type] ?? [])));
  const signature = rowsSignature(rows);
  const rule: EffectiveRule = resolveRule(rules.data ?? [], assetType, rightsType, "WORLD");
  const total = runningTotal(rows, rule);
  const errors = validateRows(rows);
  const hasErrors = Object.keys(errors).length > 0;
  const currentValidation = validation && validation.signature === signature && validation.rightsType === rightsType ? validation.result : null;

  const setRows = (updater: (rows: SplitRow[]) => SplitRow[]) => {
    setDrafts((current) => ({ ...current, [rightsType]: updater(current[rightsType] ?? baseline) }));
    setServerIssues(null);
  };
  const updateRow = (key: string, patch: Partial<SplitRow>) => setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const runValidation = async (): Promise<ValidationResult | null> => {
    setShowErrors(true);
    if (hasErrors) {
      toast.error("Fix the highlighted fields first.");
      return null;
    }
    try {
      const result = await validate.mutateAsync({
        asset_type: assetType,
        asset_id: assetId,
        shares: rows.map((row) => ({ ...toEntry(row), rights_type: rightsType })),
      });
      setValidation({ signature, rightsType, result });
      return result;
    } catch (error) {
      toast.error("Validation failed", { description: errorMessage(error) });
      return null;
    }
  };

  if (shares.isLoading) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-8 w-80" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardBody>
      </Card>
    );
  }
  if (shares.error) {
    return (
      <Card>
        <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Rights type" className="flex flex-wrap gap-2">
        {types.map((type) => {
          const count = (serverRows[type] ?? []).length;
          const draftDirty = drafts[type] !== undefined && rowsSignature(drafts[type]!) !== rowsSignature(serverRows[type] ?? []);
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={rightsType === type}
              onClick={() => setRightsType(type)}
              className={cn(
                "flex min-w-[9rem] flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                rightsType === type ? "border-primary bg-primary-soft/60" : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                {RIGHTS_TYPE_LABELS[type]}
                {draftDirty ? <Badge tone="warning">Unsaved</Badge> : null}
              </span>
              <span className="text-2xs text-fg-subtle">
                {count} active {count === 1 ? "share" : "shares"}
              </span>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader
          title={`${RIGHTS_TYPE_LABELS[rightsType]} splits`}
          description={`${RIGHTS_TYPE_HINTS[rightsType]}. Saving replaces the whole active set for this rights type: rows matching an existing party and role supersede it, other existing shares are archived.`}
          actions={
            canEdit ? (
              <Button size="sm" variant="outline" leftIcon={<RotateCcw aria-hidden />} disabled={!dirty} onClick={() => setDrafts((current) => ({ ...current, [rightsType]: undefined }))}>
                Discard changes
              </Button>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {!canEdit ? (
            <Alert tone="info" title="Read-only">
              Your role can view splits but not change them. Ask a manager to edit ownership.
            </Alert>
          ) : null}

          <TotalBar total={total} rule={rule} />

          {rows.length === 0 ? (
            <EmptyState
              compact
              title={`No ${RIGHTS_TYPE_LABELS[rightsType].toLowerCase()} shares`}
              description="Add each owner's share. The rows must add up to the expected total for every territory and period."
              action={
                canEdit ? (
                  <Button size="sm" leftIcon={<Plus aria-hidden />} onClick={() => setRows((list) => [...list, emptyRow()])}>
                    Add share
                  </Button>
                ) : null
              }
            />
          ) : (
            <ol className="space-y-3" aria-label="Share rows">
              {rows.map((row, index) => (
                <SplitRowEditor
                  key={row.key}
                  orgId={orgId}
                  index={index}
                  row={row}
                  errors={showErrors ? errors[row.key] : undefined}
                  disabled={!canEdit}
                  onChange={(patch) => updateRow(row.key, patch)}
                  onRemove={() => setRows((list) => list.filter((item) => item.key !== row.key))}
                />
              ))}
            </ol>
          )}

          {canEdit ? (
            <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="outline" size="sm" leftIcon={<Plus aria-hidden />} onClick={() => setRows((list) => [...list, emptyRow()])} disabled={rows.length >= 200}>
                Add share
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" leftIcon={<CheckCheck aria-hidden />} loading={validate.isPending} onClick={() => void runValidation()}>
                  Validate (dry run)
                </Button>
                <Button
                  leftIcon={<Save aria-hidden />}
                  disabled={!dirty || !currentValidation || currentValidation.blocked}
                  onClick={() => setSaveOpen(true)}
                  title={!currentValidation ? "Run a dry-run validation first" : undefined}
                >
                  Save splits
                </Button>
              </div>
            </div>
          ) : null}
          {canEdit && dirty && !currentValidation ? (
            <p className="text-xs text-fg-subtle">Run a dry-run validation of the current rows before saving. Nothing is written until you save.</p>
          ) : null}
        </CardBody>
      </Card>

      {serverIssues ? (
        <Card>
          <CardHeader title="Save rejected by a blocking rule" description="Nothing was saved. The backend reported these violations." />
          <CardBody>
            <IssueList issues={serverIssues} />
          </CardBody>
        </Card>
      ) : null}

      {currentValidation ? (
        <Card>
          <CardHeader title="Dry-run validation" description="Per-territory and per-period totals for the rows above, checked against your split rules. Nothing has been saved." />
          <CardBody>
            <ValidationReport result={currentValidation} />
          </CardBody>
        </Card>
      ) : null}

      <SaveSplitsDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        orgId={orgId}
        assetType={assetType}
        assetId={assetId}
        rightsType={rightsType}
        rows={rows}
        validation={currentValidation}
        verifiedCount={baseline.filter((row) => row.verified).length}
        onSaved={() => {
          setDrafts((current) => ({ ...current, [rightsType]: undefined }));
          setValidation(null);
          setShowErrors(false);
        }}
        onRejected={setServerIssues}
      />
    </div>
  );
}

function TotalBar({ total, rule }: { total: ReturnType<typeof runningTotal>; rule: EffectiveRule }) {
  const expected = Number(rule.expectedTotal) || 100;
  const width = Math.min(100, (Number(total.totalLabel) / expected) * 100);
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-4" aria-live="polite">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-fg-subtle">Running total</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
            {total.totalLabel}%<span className="ml-1 text-sm font-normal text-fg-muted">of {rule.expectedTotal}% expected</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <TotalStatusBadge status={total.status} />
          <span className="text-xs tabular-nums text-fg-muted">
            {total.status === "invalid" ? `${total.invalid} invalid ${total.invalid === 1 ? "value" : "values"}` : `${total.remaining}% remaining`}
          </span>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            total.status === "over" ? "bg-danger" : total.status === "ok" ? "bg-success" : "bg-warning",
          )}
          style={{ width: `${Math.max(0, width)}%` }}
        />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
        <ShieldCheck className="size-3.5" aria-hidden />
        {rule.scope} · tolerance ±{rule.tolerance}% · {rule.enforcement === "block" ? "blocks saving when off" : "warns when off"}
        {rule.allowUnderAllocation ? " · under-allocation allowed" : ""}
      </p>
      {!total.uniformScope ? (
        <p className="mt-1 text-xs text-warning-soft-fg">
          Rows cover different territories or dates, so this sum is indicative. Run the dry-run validation for exact per-territory totals.
        </p>
      ) : null}
    </div>
  );
}

function ContractValue({ orgId, value, onChange, disabled, ...aria }: { orgId: string; value: PickedRef | null; onChange: (value: PickedRef | null) => void; disabled?: boolean; id?: string; "aria-describedby"?: string }) {
  const needsLabel = Boolean(value && !value.label);
  const contract = useContract(orgId, needsLabel ? value?.id : null);
  const resolved = value ? { id: value.id, label: value.label || contract.data?.title || "Linked contract" } : null;
  return <ContractPicker {...aria} size="sm" orgId={orgId} value={resolved} onChange={onChange} disabled={disabled} />;
}

function SplitRowEditor({
  orgId,
  index,
  row,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  orgId: string;
  index: number;
  row: SplitRow;
  errors?: RowErrors;
  disabled: boolean;
  onChange: (patch: Partial<SplitRow>) => void;
  onRemove: () => void;
}) {
  return (
    <li className={cn("rounded-lg border bg-surface p-3", errors ? "border-danger/50" : "border-border")} aria-label={`Share ${index + 1}`}>
      <div className="grid gap-3 md:grid-cols-12">
        <FormField label="Party" required error={errors?.party} className="md:col-span-4">
          {(props) => <PartyPicker {...props} size="sm" orgId={orgId} value={row.party} onChange={(party) => onChange({ party })} disabled={disabled} />}
        </FormField>
        <FormField label="Role" required className="md:col-span-2">
          {(props) => (
            <Select
              {...props}
              size="sm"
              value={row.role}
              onValueChange={(role) => onChange({ role })}
              options={SHARE_ROLES.map((value) => ({ value, label: SHARE_ROLE_LABELS[value] }))}
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField label="Share %" required error={errors?.share_percent} className="md:col-span-2">
          <Input
            inputMode="decimal"
            className="h-8 text-right tabular-nums"
            value={row.share_percent}
            placeholder="0"
            onChange={(event) => onChange({ share_percent: event.target.value })}
            disabled={disabled}
          />
        </FormField>
        <FormField label="Territories" required error={errors?.territories} className="md:col-span-4">
          {(props) => (
            <TerritorySelect
              {...props}
              size="sm"
              value={row.territories}
              excluded={row.excluded_territories}
              onChange={(territories) => onChange({ territories })}
              onExcludedChange={(excluded_territories) => onChange({ excluded_territories })}
              disabled={disabled}
            />
          )}
        </FormField>
        <FormField label="Effective from" className="md:col-span-2">
          <Input type="date" className="h-8 text-[13px]" value={row.effective_from} onChange={(event) => onChange({ effective_from: event.target.value })} disabled={disabled} />
        </FormField>
        <FormField label="Effective to" error={errors?.effective_to} className="md:col-span-2">
          <Input type="date" className="h-8 text-[13px]" value={row.effective_to} onChange={(event) => onChange({ effective_to: event.target.value })} disabled={disabled} />
        </FormField>
        <FormField label="Contract" className="md:col-span-4">
          {(props) => <ContractValue {...props} orgId={orgId} value={row.contract} onChange={(contract) => onChange({ contract })} disabled={disabled} />}
        </FormField>
        <div className="flex items-end justify-between gap-3 md:col-span-4">
          <div className="flex h-8 items-center gap-2">
            <Switch id={`${row.key}-controlled`} checked={row.is_controlled} onCheckedChange={(is_controlled) => onChange({ is_controlled })} disabled={disabled} />
            <Label htmlFor={`${row.key}-controlled`} className="font-normal">
              Controlled
            </Label>
            {row.verified ? <Badge tone="success">Verified</Badge> : null}
          </div>
          {!disabled ? <IconButton label={`Remove share ${index + 1}`} icon={<Trash2 aria-hidden />} variant="danger" size="sm" onClick={onRemove} /> : null}
        </div>
      </div>
    </li>
  );
}

function SaveSplitsDialog({
  open,
  onOpenChange,
  orgId,
  assetType,
  assetId,
  rightsType,
  rows,
  validation,
  verifiedCount,
  onSaved,
  onRejected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  assetType: AssetType;
  assetId: string;
  rightsType: RightsType;
  rows: SplitRow[];
  validation: ValidationResult | null;
  verifiedCount: number;
  onSaved: () => void;
  onRejected: (issues: RightsValidationIssue[]) => void;
}) {
  const replace = useReplaceSplits(orgId, assetType, assetId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const warnings = validation?.issues.filter((issue) => !issue.blocking).length ?? 0;

  const save = () => {
    setError(null);
    replace.mutate(
      { rights_type: rightsType, shares: rows.map(toEntry), reason: reason.trim() || null },
      {
        onSuccess: (result) => {
          const parts = [`${result.shares.length} active`, `${result.superseded} superseded`, `${result.archived} archived`];
          if (result.validation.issues.length > 0) {
            toast.warning(`${RIGHTS_TYPE_LABELS[rightsType]} splits saved with warnings`, {
              description: `${parts.join(", ")}. ${result.validation.issues.length} issue(s) recorded as conflicts for review.`,
            });
          } else {
            toast.success(`${RIGHTS_TYPE_LABELS[rightsType]} splits saved`, { description: parts.join(", ") });
          }
          setReason("");
          onSaved();
          onOpenChange(false);
        },
        onError: (cause) => {
          if (isApiError(cause) && cause.code === "split_rule_violation") {
            const details = cause.details as { issues?: RightsValidationIssue[] } | null;
            onRejected(details?.issues ?? []);
            onOpenChange(false);
            toast.error("Blocked by a split rule", { description: cause.message });
            return;
          }
          const issues = validationIssues(cause);
          setError(issues.length > 1 ? issues.map((issue) => `${issue.loc.slice(1).join(".")}: ${issue.message}`).join(" · ") : errorMessage(cause));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !replace.isPending && onOpenChange(next)}
      title={`Save ${RIGHTS_TYPE_LABELS[rightsType].toLowerCase()} splits?`}
      description={`This replaces the active ${RIGHTS_TYPE_LABELS[rightsType].toLowerCase()} share set with ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={replace.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={replace.isPending} leftIcon={<Save aria-hidden />}>
            Save splits
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert tone="danger" assertive>
            {error}
          </Alert>
        ) : null}
        {warnings > 0 ? (
          <Alert tone="warning" title={`Saving with ${warnings} ${warnings === 1 ? "warning" : "warnings"}`}>
            The dry run found issues that do not block saving. They will be recorded as rights conflicts for review.
          </Alert>
        ) : null}
        {verifiedCount > 0 ? (
          <Alert tone="info">
            {verifiedCount} verified {verifiedCount === 1 ? "share" : "shares"} will be superseded or archived. New shares start unverified.
          </Alert>
        ) : null}
        {rows.length === 0 ? (
          <Alert tone="warning">No rows: every active share of this rights type will be archived.</Alert>
        ) : null}
        <FormField label="Reason for change" hint="Optional. Stored in the rights history.">
          <Textarea rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
