"use client";

import { Disc3, FileText, Plus, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";

import { AssetPicker, PartyPicker, type PickedRef } from "@/components/rights/pickers";
import { parsePercent, rightsTypeLabel, trimPercent } from "@/components/rights/rights-format";
import { scopeError } from "@/components/rights/territory-scope";
import { TerritorySelect } from "@/components/rights/territory-select";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import type { ContractCreate, ContractDetail } from "@/lib/api/hooks/contracts";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";
import { titleCase } from "@/lib/utils";

import {
  ALL_RIGHTS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  isValidAmount,
  PARTY_ROLES,
  SOURCE_CATEGORIES,
  statusOptions,
  trimDecimal,
  type ContractPartyRole,
  type ContractStatus,
  type ContractType,
} from "./contract-format";

let counter = 0;
const uid = () => `k${(counter += 1)}`;

interface PartyRow {
  key: string;
  party: PickedRef | null;
  role: ContractPartyRole;
  signed_at: string;
}

interface TermRow {
  key: string;
  id: string | null;
  payee: PickedRef | null;
  rights_type: string;
  source_category: string;
  territories: string[];
  rate_percent: string;
  basis: "gross" | "net";
  description: string;
}

interface AssetRow {
  key: string;
  type: "work" | "recording";
  ref: PickedRef;
  code?: string | null;
}

export interface ContractFormState {
  title: string;
  reference: string;
  contract_type: ContractType;
  status: ContractStatus;
  start_date: string;
  end_date: string;
  renewal_date: string;
  auto_renew: boolean;
  notice_period_days: string;
  territories: string[];
  rights_granted: string[];
  currency: string;
  advance_amount: string;
  is_recoupable: boolean;
  summary: string;
  notes: string;
  parties: PartyRow[];
  terms: TermRow[];
  assets: AssetRow[];
}

export function initialFormState(contract: ContractDetail | null, defaultCurrency: string): ContractFormState {
  if (!contract) {
    return {
      title: "",
      reference: "",
      contract_type: "publishing",
      status: "draft",
      start_date: "",
      end_date: "",
      renewal_date: "",
      auto_renew: false,
      notice_period_days: "",
      territories: ["WORLD"],
      rights_granted: [],
      currency: defaultCurrency || "USD",
      advance_amount: "",
      is_recoupable: false,
      summary: "",
      notes: "",
      parties: [],
      terms: [],
      assets: [],
    };
  }
  return {
    title: contract.title,
    reference: contract.reference ?? "",
    contract_type: contract.contract_type as ContractType,
    status: contract.status as ContractStatus,
    start_date: contract.start_date ?? "",
    end_date: contract.end_date ?? "",
    renewal_date: contract.renewal_date ?? "",
    auto_renew: contract.auto_renew,
    notice_period_days: contract.notice_period_days?.toString() ?? "",
    territories: contract.territories,
    rights_granted: contract.rights_granted,
    currency: contract.currency,
    advance_amount: contract.advance_amount ? trimDecimal(contract.advance_amount) : "",
    is_recoupable: contract.is_recoupable,
    summary: contract.summary ?? "",
    notes: contract.notes ?? "",
    parties: contract.parties.map((party) => ({
      key: uid(),
      party: { id: party.party_id, label: party.party_name ?? party.party_id },
      role: party.role as ContractPartyRole,
      signed_at: party.signed_at ?? "",
    })),
    terms: contract.royalty_terms.map((term) => ({
      key: uid(),
      id: term.id,
      payee: term.payee_party_id ? { id: term.payee_party_id, label: term.payee_name ?? term.payee_party_id } : null,
      rights_type: term.rights_type ?? "",
      source_category: term.source_category ?? "",
      territories: term.territories ?? [],
      rate_percent: trimPercent(term.rate_percent),
      basis: term.basis === "gross" ? "gross" : "net",
      description: term.description ?? "",
    })),
    assets: contract.assets.map((asset) => ({
      key: uid(),
      type: asset.asset_type,
      ref: { id: (asset.work_id ?? asset.recording_id)!, label: asset.title ?? "Untitled" },
      code: asset.code,
    })),
  };
}

/** Client checks mirroring backend ContractCreate / ContractUpdate validators. */
export function validateContractForm(state: ContractFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!state.title.trim()) errors.title = "Title is required.";
  if (state.title.length > 255) errors.title = "At most 255 characters.";
  if (state.reference.length > 60) errors.reference = "At most 60 characters.";
  if (state.start_date && state.end_date && state.end_date < state.start_date) errors.end_date = "End date must be on or after the start date.";
  if (state.notice_period_days && !/^\d{1,4}$/.test(state.notice_period_days.trim())) errors.notice_period_days = "Whole days between 0 and 3650.";
  else if (state.notice_period_days && Number(state.notice_period_days) > 3650) errors.notice_period_days = "Whole days between 0 and 3650.";
  const territoryError = scopeError({ territories: state.territories, excluded: [] });
  if (territoryError) errors.territories = territoryError;
  if (state.advance_amount && !isValidAmount(state.advance_amount)) errors.advance_amount = "Enter a non-negative amount (up to 8 decimals).";
  const partyKeys = new Set<string>();
  state.parties.forEach((row, index) => {
    if (!row.party) errors[`parties.${index}`] = "Select a party.";
    const key = `${row.party?.id}:${row.role}`;
    if (row.party && partyKeys.has(key)) errors[`parties.${index}`] = "The same party is listed twice with the same role.";
    partyKeys.add(key);
  });
  state.terms.forEach((row, index) => {
    const parsed = parsePercent(row.rate_percent);
    if (parsed === null || parsed > BigInt(100_000_000)) errors[`terms.${index}`] = "Rate must be between 0 and 100 (max 6 decimals).";
  });
  return errors;
}

export function toPayload(state: ContractFormState): ContractCreate {
  return {
    title: state.title.trim(),
    reference: state.reference.trim() || null,
    contract_type: state.contract_type,
    status: state.status as ContractCreate["status"],
    start_date: state.start_date || null,
    end_date: state.end_date || null,
    renewal_date: state.renewal_date || null,
    auto_renew: state.auto_renew,
    notice_period_days: state.notice_period_days.trim() ? Number(state.notice_period_days) : null,
    territories: state.territories,
    rights_granted: state.rights_granted,
    currency: state.currency,
    advance_amount: state.advance_amount.trim() || null,
    is_recoupable: state.is_recoupable,
    summary: state.summary.trim() || null,
    notes: state.notes.trim() || null,
    parties: state.parties.filter((row) => row.party).map((row) => ({ party_id: row.party!.id, role: row.role, signed_at: row.signed_at || null })),
    royalty_terms: state.terms.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      payee_party_id: row.payee?.id ?? null,
      rights_type: row.rights_type || null,
      source_category: row.source_category || null,
      territories: row.territories.length ? row.territories : null,
      rate_percent: row.rate_percent.trim(),
      basis: row.basis,
      description: row.description.trim() || null,
    })),
    assets: state.assets.map((row) => (row.type === "work" ? { work_id: row.ref.id } : { recording_id: row.ref.id })),
  };
}

export interface ContractFormProps {
  orgId: string;
  contract: ContractDetail | null;
  defaultCurrency: string;
  submitting: boolean;
  serverErrors: Record<string, string>;
  formError: ReactNode;
  onSubmit: (state: ContractFormState) => void;
  cancelHref: string;
}

export function ContractForm({ orgId, contract, defaultCurrency, submitting, serverErrors, formError, onSubmit, cancelHref }: ContractFormProps) {
  const [state, setState] = useState(() => initialFormState(contract, defaultCurrency));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const currencies = useCurrencyCodes();
  const dirty = useIsDirty(state);
  useUnsavedChangesWarning(dirty);
  const errors = { ...serverErrors, ...clientErrors };
  const set = <K extends keyof ContractFormState>(key: K, value: ContractFormState[K]) => setState((current) => ({ ...current, [key]: value }));
  const statuses = statusOptions(contract?.status ?? null, contract?.allowed_status_transitions);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = validateContractForm(state);
    setClientErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit(state);
  };

  const updateParty = (key: string, patch: Partial<PartyRow>) => set("parties", state.parties.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const updateTerm = (key: string, patch: Partial<TermRow>) => set("terms", state.terms.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {formError ? (
        <Alert tone="danger" assertive>
          {formError}
        </Alert>
      ) : null}
      {Object.keys(clientErrors).length > 0 ? <Alert tone="danger">Fix the highlighted fields ({Object.keys(clientErrors).length}).</Alert> : null}

      <Card>
        <CardHeader title="Key terms" description="Identification, lifecycle and commercial terms." />
        <CardBody className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <FormField label="Title" required error={errors.title} className="md:col-span-2">
            <Input value={state.title} maxLength={255} onChange={(event) => set("title", event.target.value)} autoFocus={!contract} />
          </FormField>
          <FormField label="Reference" error={errors.reference} hint="Your internal contract number. Must be unique.">
            <Input value={state.reference} maxLength={60} onChange={(event) => set("reference", event.target.value)} />
          </FormField>
          <FormField label="Type" required error={errors.contract_type}>
            {(props) => <Select {...props} value={state.contract_type} onValueChange={(value) => set("contract_type", value)} options={CONTRACT_TYPES.map((value) => ({ value, label: titleCase(value) }))} />}
          </FormField>
          <FormField
            label="Status"
            required
            error={errors.status}
            hint={contract ? (statuses.length === 1 ? "No further status changes are allowed." : `Allowed from ${CONTRACT_STATUS_LABELS[contract.status as ContractStatus] ?? contract.status}: ${statuses.slice(1).map((value) => CONTRACT_STATUS_LABELS[value]).join(", ")}.`) : "New contracts start as draft, pending signature or active."}
          >
            {(props) => <Select {...props} value={state.status} onValueChange={(value) => set("status", value)} options={statuses.map((value) => ({ value, label: CONTRACT_STATUS_LABELS[value] }))} />}
          </FormField>
          <FormField label="Currency" required error={errors.currency}>
            <NativeSelect value={state.currency} onChange={(event) => set("currency", event.target.value)}>
              {[...new Set([state.currency, ...currencies])].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Start date" error={errors.start_date}>
            <Input type="date" value={state.start_date} onChange={(event) => set("start_date", event.target.value)} />
          </FormField>
          <FormField label="End date" error={errors.end_date} hint="Drives expiry warnings.">
            <Input type="date" value={state.end_date} onChange={(event) => set("end_date", event.target.value)} />
          </FormField>
          <FormField label="Renewal date" error={errors.renewal_date}>
            <Input type="date" value={state.renewal_date} onChange={(event) => set("renewal_date", event.target.value)} />
          </FormField>
          <FormField label="Notice period (days)" error={errors.notice_period_days}>
            <Input inputMode="numeric" value={state.notice_period_days} onChange={(event) => set("notice_period_days", event.target.value)} />
          </FormField>
          <FormField label="Advance" error={errors.advance_amount} hint={`Amount in ${state.currency}.`}>
            <Input inputMode="decimal" value={state.advance_amount} onChange={(event) => set("advance_amount", event.target.value)} placeholder="0.00" />
          </FormField>
          <div className="flex flex-col justify-end gap-3 pb-1">
            <div className="flex items-center gap-2">
              <Switch id="contract-auto-renew" checked={state.auto_renew} onCheckedChange={(value) => set("auto_renew", value)} />
              <Label htmlFor="contract-auto-renew" className="font-normal">
                Auto-renews
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="contract-recoupable" checked={state.is_recoupable} onCheckedChange={(value) => set("is_recoupable", value)} />
              <Label htmlFor="contract-recoupable" className="font-normal">
                Advance is recoupable
              </Label>
            </div>
          </div>
          <FormField label="Territories" required error={errors.territories} className="md:col-span-2">
            {(props) => <TerritorySelect {...props} value={state.territories} onChange={(value) => set("territories", value)} />}
          </FormField>
          <fieldset className="space-y-2 md:col-span-2 xl:col-span-3">
            <legend className="text-[13px] font-medium">Rights granted</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {ALL_RIGHTS.map((right) => (
                <div key={right} className="flex items-center gap-2">
                  <Checkbox
                    id={`right-${right}`}
                    checked={state.rights_granted.includes(right)}
                    onCheckedChange={(checked) => set("rights_granted", checked ? [...state.rights_granted, right] : state.rights_granted.filter((item) => item !== right))}
                  />
                  <Label htmlFor={`right-${right}`} className="font-normal">
                    {rightsTypeLabel(right)}
                  </Label>
                </div>
              ))}
            </div>
            {errors.rights_granted ? <p className="text-xs font-medium text-danger">{errors.rights_granted}</p> : null}
          </fieldset>
          <FormField label="Summary" error={errors.summary} className="md:col-span-2 xl:col-span-3">
            <Textarea rows={3} maxLength={10000} value={state.summary} onChange={(event) => set("summary", event.target.value)} />
          </FormField>
          <FormField label="Internal notes" error={errors.notes} className="md:col-span-2 xl:col-span-3">
            <Textarea rows={3} maxLength={20000} value={state.notes} onChange={(event) => set("notes", event.target.value)} />
          </FormField>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Parties"
          description="Who signed the agreement and in what capacity."
          actions={
            <Button size="sm" variant="outline" leftIcon={<Plus aria-hidden />} onClick={() => set("parties", [...state.parties, { key: uid(), party: null, role: "licensor", signed_at: "" }])}>
              Add party
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {errors.parties ? <p className="text-xs font-medium text-danger">{errors.parties}</p> : null}
          {state.parties.length === 0 ? <p className="text-[13px] text-fg-subtle">No parties yet.</p> : null}
          {state.parties.map((row, index) => (
            <div key={row.key} className="grid items-start gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_12rem_11rem_auto]">
              <FormField label={`Party ${index + 1}`} required error={errors[`parties.${index}`]}>
                {(props) => <PartyPicker {...props} size="sm" orgId={orgId} value={row.party} onChange={(party) => updateParty(row.key, { party })} />}
              </FormField>
              <FormField label="Role">
                {(props) => <Select {...props} size="sm" value={row.role} onValueChange={(role) => updateParty(row.key, { role })} options={PARTY_ROLES.map((value) => ({ value, label: titleCase(value) }))} />}
              </FormField>
              <FormField label="Signed on">
                <Input type="date" className="h-8 text-[13px]" value={row.signed_at} onChange={(event) => updateParty(row.key, { signed_at: event.target.value })} />
              </FormField>
              <IconButton className="md:mt-6" label={`Remove party ${index + 1}`} icon={<Trash2 aria-hidden />} variant="danger" size="sm" onClick={() => set("parties", state.parties.filter((item) => item.key !== row.key))} />
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Royalty terms"
          description="Rates payable under this agreement. Leave rights type, source or territories empty to apply to all."
          actions={
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Plus aria-hidden />}
              onClick={() => set("terms", [...state.terms, { key: uid(), id: null, payee: null, rights_type: "", source_category: "", territories: [], rate_percent: "", basis: "net", description: "" }])}
            >
              Add term
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {state.terms.length === 0 ? <p className="text-[13px] text-fg-subtle">No royalty terms yet.</p> : null}
          {state.terms.map((row, index) => (
            <div key={row.key} className="space-y-3 rounded-lg border border-border p-3">
              <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
                <FormField label="Payee">
                  {(props) => <PartyPicker {...props} size="sm" clearable orgId={orgId} value={row.payee} onChange={(payee) => updateTerm(row.key, { payee })} placeholder="Any / unspecified" />}
                </FormField>
                <FormField label="Rights type">
                  <NativeSelect className="h-8 text-[13px]" value={row.rights_type} onChange={(event) => updateTerm(row.key, { rights_type: event.target.value })}>
                    <option value="">All rights types</option>
                    {ALL_RIGHTS.map((right) => (
                      <option key={right} value={right}>
                        {rightsTypeLabel(right)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Source category">
                  <NativeSelect className="h-8 text-[13px]" value={row.source_category} onChange={(event) => updateTerm(row.key, { source_category: event.target.value })}>
                    <option value="">All sources</option>
                    {Object.entries(SOURCE_CATEGORIES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Territories">
                  {(props) => <TerritorySelect {...props} size="sm" emptyLabel="All territories" value={row.territories} onChange={(territories) => updateTerm(row.key, { territories })} />}
                </FormField>
              </div>
              <div className="grid items-start gap-3 md:grid-cols-[8rem_9rem_1fr_auto]">
                <FormField label="Rate %" required error={errors[`terms.${index}`]}>
                  <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={row.rate_percent} onChange={(event) => updateTerm(row.key, { rate_percent: event.target.value })} />
                </FormField>
                <FormField label="Basis">
                  {(props) => (
                    <Select
                      {...props}
                      size="sm"
                      value={row.basis}
                      onValueChange={(basis) => updateTerm(row.key, { basis })}
                      options={[
                        { value: "gross", label: "Gross" },
                        { value: "net", label: "Net" },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label="Description">
                  <Input className="h-8 text-[13px]" maxLength={255} value={row.description} onChange={(event) => updateTerm(row.key, { description: event.target.value })} />
                </FormField>
                <IconButton className="md:mt-6" label={`Remove term ${index + 1}`} icon={<Trash2 aria-hidden />} variant="danger" size="sm" onClick={() => set("terms", state.terms.filter((item) => item.key !== row.key))} />
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Catalog items" description="Works and recordings covered by this agreement." />
        <CardBody className="space-y-4">
          <AssetAdder orgId={orgId} onAdd={(type, ref) => !state.assets.some((row) => row.ref.id === ref.id) && set("assets", [...state.assets, { key: uid(), type, ref }])} />
          {errors.assets ? <p className="text-xs font-medium text-danger">{errors.assets}</p> : null}
          {state.assets.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">No catalog items linked.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {state.assets.map((row) => (
                <li key={row.key} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  {row.type === "work" ? <FileText className="size-4 text-fg-subtle" aria-hidden /> : <Disc3 className="size-4 text-fg-subtle" aria-hidden />}
                  <Link href={`/catalog/${row.type === "work" ? "works" : "recordings"}/${row.ref.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-primary hover:underline">
                    {row.ref.label}
                  </Link>
                  <Badge tone="neutral">{titleCase(row.type)}</Badge>
                  {row.code ? <span className="hidden font-mono text-2xs text-fg-subtle sm:inline">{row.code}</span> : null}
                  <IconButton label={`Remove ${row.ref.label}`} icon={<Trash2 aria-hidden />} variant="danger" size="xs" onClick={() => set("assets", state.assets.filter((item) => item.key !== row.key))} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 border-t border-border bg-bg/90 px-1 py-3 backdrop-blur">
        <ButtonLink href={cancelHref} variant="outline">
          Cancel
        </ButtonLink>
        <Button type="submit" loading={submitting} leftIcon={<Save aria-hidden />}>
          {contract ? "Save changes" : "Create contract"}
        </Button>
      </div>
    </form>
  );
}

function AssetAdder({ orgId, onAdd }: { orgId: string; onAdd: (type: "work" | "recording", ref: PickedRef) => void }) {
  const [type, setType] = useState<"work" | "recording">("work");
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select
        size="sm"
        className="sm:w-36"
        aria-label="Catalog item type"
        value={type}
        onValueChange={setType}
        options={[
          { value: "work", label: "Work" },
          { value: "recording", label: "Recording" },
        ]}
      />
      <AssetPicker
        key={type}
        size="sm"
        orgId={orgId}
        assetType={type}
        value={null}
        onChange={(ref) => ref && onAdd(type, ref)}
        placeholder={type === "work" ? "Search and add a work…" : "Search and add a recording…"}
        aria-label={type === "work" ? "Add a work" : "Add a recording"}
        className="sm:flex-1"
      />
    </div>
  );
}
