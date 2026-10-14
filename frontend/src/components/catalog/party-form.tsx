"use client";

import { useState, type FormEvent } from "react";

import { FormSection, SaveErrorAlert, SubmitBar } from "@/components/catalog/form-shell";
import { externalIdsPayload, rowsFromExternalIds, validateExternalIds, type ExternalIdRow } from "@/components/catalog/external-ids";
import { ExternalIdsEditor } from "@/components/catalog/external-ids-editor";
import { omitKey, toNull } from "@/components/catalog/form-utils";
import { formatIsni, identifierError } from "@/components/catalog/identifiers";
import { codeLabel, entityHref } from "@/components/catalog/labels";
import { RoleToggleGroup } from "@/components/catalog/role-toggle-group";
import { useCatalogSave } from "@/components/catalog/use-catalog-save";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useReferenceList } from "@/lib/api/hooks/reference";
import { PARTY_ROLES, type CatalogStatus, type PartyDetail, type PartyInput, type PartyRole, type PartyType } from "@/lib/api/hooks/catalog";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";

export interface PartyValues {
  name: string;
  party_type: PartyType;
  roles: PartyRole[];
  legal_name: string;
  email: string;
  country_code: string;
  ipi_number: string;
  isni: string;
  pro_affiliation: string;
  is_internal: boolean;
  notes: string;
  status: CatalogStatus;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateParty(values: PartyValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.name.trim()) errors.name = "This field is required";
  else if (values.name.trim().length > 255) errors.name = "Ensure this value has at most 255 characters";
  if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) errors.email = "Enter a valid email address";
  const ipi = identifierError("ipi", values.ipi_number);
  if (ipi) errors.ipi_number = ipi;
  const isni = identifierError("isni", values.isni);
  if (isni) errors.isni = isni;
  if (values.pro_affiliation.trim().length > 100) errors.pro_affiliation = "Ensure this value has at most 100 characters";
  return errors;
}

export function PartyForm({ orgId, party }: { orgId: string; party?: PartyDetail }) {
  const territories = useReferenceList("territories");
  const [values, setValues] = useState<PartyValues>(() => ({
    name: party?.name ?? "",
    party_type: (party?.party_type as PartyType) ?? "person",
    roles: (party?.roles ?? []) as PartyRole[],
    legal_name: party?.legal_name ?? "",
    email: party?.email ?? "",
    country_code: party?.country_code ?? "",
    ipi_number: party?.ipi_number ?? "",
    isni: party?.isni ? formatIsni(party.isni) : "",
    pro_affiliation: party?.pro_affiliation ?? "",
    is_internal: party?.is_internal ?? false,
    notes: party?.notes ?? "",
    status: (party?.status as CatalogStatus) ?? "active",
  }));
  const [externalIds, setExternalIds] = useState<ExternalIdRow[]>(() => rowsFromExternalIds(party?.external_ids));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { save, pending, saveError } = useCatalogSave(orgId, "party", party?.id ?? null, setErrors);
  const dirty = useIsDirty({ values, externalIds });
  useUnsavedChangesWarning(dirty);

  const set = <K extends keyof PartyValues>(key: K, value: PartyValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => omitKey(current, key));
  };

  const submitForm = (allowDuplicate = false) => {
    const clientErrors = validateParty(values);
    const extErrors = validateExternalIds(externalIds);
    setErrors({ ...clientErrors, ...extErrors });
    if (Object.keys(clientErrors).length > 0 || Object.keys(extErrors).length > 0) return;
    const body: PartyInput = {
      name: values.name.trim(),
      party_type: values.party_type,
      roles: values.roles,
      legal_name: toNull(values.legal_name),
      email: toNull(values.email),
      country_code: toNull(values.country_code),
      ipi_number: toNull(values.ipi_number),
      isni: toNull(values.isni),
      pro_affiliation: toNull(values.pro_affiliation),
      is_internal: values.is_internal,
      notes: toNull(values.notes),
      external_ids: externalIdsPayload(externalIds),
      status: values.status,
    };
    save(body, allowDuplicate);
  };

  const statusOptions = (party ? (["active", "draft", "archived"] as const) : (["active", "draft"] as const)).map((value) => ({ value, label: codeLabel(value) }));
  const countries = (territories.data ?? []).filter((item) => item.code.length === 2);

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submitForm();
      }}
      noValidate className="space-y-5">
      <SaveErrorAlert error={saveError} entity="party" onSaveAnyway={() => submitForm(true)} pending={pending} mode={party ? "edit" : "create"} />
      <FormSection title="Identity" description="Artists, writers, publishers and labels are all parties.">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField label="Name" required hint="Professional or trading name." error={errors.name}>
            <Input value={values.name} onChange={(event) => set("name", event.target.value)} maxLength={255} autoFocus={!party} />
          </FormField>
          <FormField label="Type" error={errors.party_type}>
            {(field) => (
              <Select {...field} value={values.party_type} onValueChange={(value) => set("party_type", value)} options={(["person", "company"] as const).map((value) => ({ value, label: codeLabel(value) }))} />
            )}
          </FormField>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-fg">Roles</legend>
          <RoleToggleGroup options={PARTY_ROLES} value={values.roles} onChange={(roles) => set("roles", roles)} />
          {errors.roles ? <p className="text-xs font-medium text-danger">{errors.roles}</p> : null}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Legal name" error={errors.legal_name}>
            <Input value={values.legal_name} onChange={(event) => set("legal_name", event.target.value)} maxLength={255} />
          </FormField>
          <FormField label="Email" error={errors.email}>
            <Input type="email" value={values.email} onChange={(event) => set("email", event.target.value)} autoComplete="off" />
          </FormField>
        </div>
        <FormField label="Country" error={errors.country_code} className="sm:max-w-xs">
          <NativeSelect value={values.country_code} onChange={(event) => set("country_code", event.target.value)}>
            <option value="">Not set</option>
            {values.country_code && !countries.some((item) => item.code === values.country_code) ? <option value={values.country_code}>{values.country_code}</option> : null}
            {countries.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} ({item.code})
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </FormSection>

      <FormSection title="Society identifiers" description="Used to match statements and register works with collecting societies.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="IPI name number" hint="9–11 digits." error={errors.ipi_number}>
            <Input value={values.ipi_number} onChange={(event) => set("ipi_number", event.target.value)} inputMode="numeric" className="font-mono" autoComplete="off" />
          </FormField>
          <FormField label="ISNI" hint="16 characters, check character verified." error={errors.isni}>
            <Input
              value={values.isni}
              onChange={(event) => set("isni", event.target.value)}
              onBlur={() => {
                if (values.isni.trim() && !identifierError("isni", values.isni)) set("isni", formatIsni(values.isni));
              }}
              className="font-mono"
              placeholder="0000 0001 2103 2683"
              autoComplete="off"
            />
          </FormField>
        </div>
        <FormField label="PRO affiliation" hint="e.g. ASCAP, BMI, PRS" error={errors.pro_affiliation} className="sm:max-w-xs">
          <Input value={values.pro_affiliation} onChange={(event) => set("pro_affiliation", event.target.value)} maxLength={100} />
        </FormField>
      </FormSection>

      <FormSection title="External identifiers" description="Platform profile ids (e.g. Spotify artist id, MusicBrainz id).">
        <ExternalIdsEditor rows={externalIds} onChange={setExternalIds} errors={errors} showErrors={true} />
      </FormSection>

      <FormSection title="Status & notes">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Status" error={errors.status}>
            {(field) => <Select {...field} value={values.status} onValueChange={(value) => set("status", value)} options={statusOptions} />}
          </FormField>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="party-internal">Internal party</Label>
            <div className="flex h-9 items-center gap-2">
              <Switch id="party-internal" checked={values.is_internal} onCheckedChange={(checked) => set("is_internal", checked)} />
              <span className="text-[13px] text-fg-muted">{values.is_internal ? "Part of your organization" : "External party"}</span>
            </div>
          </div>
        </div>
        <FormField label="Internal notes" error={errors.notes}>
          <Textarea rows={3} maxLength={10000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
        </FormField>
      </FormSection>

      <SubmitBar cancelHref={party ? entityHref("party", party.id) : entityHref("party")} submitLabel={party ? "Save changes" : "Create party"} pending={pending} />
    </form>
  );
}
