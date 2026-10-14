"use client";

import { X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { CatalogPicker } from "@/components/catalog/catalog-picker";
import { FormSection, SaveErrorAlert, SubmitBar } from "@/components/catalog/form-shell";
import { externalIdsPayload, rowsFromExternalIds, validateExternalIds, type ExternalIdRow } from "@/components/catalog/external-ids";
import { ExternalIdsEditor } from "@/components/catalog/external-ids-editor";
import { omitKey, toNull } from "@/components/catalog/form-utils";
import { identifierError } from "@/components/catalog/identifiers";
import { codeLabel, entityHref } from "@/components/catalog/labels";
import { QuickPartyDialog } from "@/components/catalog/quick-party-dialog";
import { toTrackPayload, trackListProblems, tracksFromRelease, type TrackRow } from "@/components/catalog/track-list";
import { TrackListEditor } from "@/components/catalog/track-list-editor";
import { useCatalogSave } from "@/components/catalog/use-catalog-save";
import { IconButton } from "@/components/ui/icon-button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RELEASE_TYPES, type CatalogStatus, type Party, type Release, type ReleaseInput, type ReleaseType } from "@/lib/api/hooks/catalog";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";

export interface ReleaseValues {
  title: string;
  release_type: ReleaseType;
  upc: string;
  catalog_number: string;
  display_artist: string;
  release_date: string;
  c_line: string;
  notes: string;
  status: CatalogStatus;
}

export function validateRelease(values: ReleaseValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.title.trim()) errors.title = "This field is required";
  else if (values.title.trim().length > 255) errors.title = "Ensure this value has at most 255 characters";
  const upc = identifierError("upc", values.upc);
  if (upc) errors.upc = upc;
  if (values.catalog_number.trim().length > 50) errors.catalog_number = "Ensure this value has at most 50 characters";
  if (values.release_date && !/^\d{4}-\d{2}-\d{2}$/.test(values.release_date)) errors.release_date = "Enter a valid date";
  return errors;
}

export function ReleaseForm({ orgId, release }: { orgId: string; release?: Release }) {
  const [values, setValues] = useState<ReleaseValues>(() => ({
    title: release?.title ?? "",
    release_type: (release?.release_type as ReleaseType) ?? "album",
    upc: release?.upc ?? "",
    catalog_number: release?.catalog_number ?? "",
    display_artist: release?.display_artist ?? "",
    release_date: release?.release_date ?? "",
    c_line: release?.c_line ?? "",
    notes: release?.notes ?? "",
    status: (release?.status as CatalogStatus) ?? "active",
  }));
  const [label, setLabel] = useState<{ id: string; name: string } | null>(() =>
    release?.label_id ? { id: release.label_id, name: release.label_name ?? "Unknown label" } : null,
  );
  const [creatingLabel, setCreatingLabel] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackRow[]>(() => tracksFromRelease(release?.tracks ?? []));
  const [externalIds, setExternalIds] = useState<ExternalIdRow[]>(() => rowsFromExternalIds(release?.external_ids));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { save, pending, saveError } = useCatalogSave(orgId, "release", release?.id ?? null, setErrors);
  const dirty = useIsDirty({ values, label, tracks, externalIds });
  useUnsavedChangesWarning(dirty);

  const set = <K extends keyof ReleaseValues>(key: K, value: ReleaseValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => omitKey(current, key));
  };

  const submitForm = (allowDuplicate = false) => {
    const clientErrors = validateRelease(values);
    const extErrors = validateExternalIds(externalIds);
    setErrors({ ...clientErrors, ...extErrors });
    if (Object.keys(clientErrors).length > 0 || trackListProblems(tracks).errors.length > 0 || Object.keys(extErrors).length > 0) return;
    const body: ReleaseInput = {
      title: values.title.trim(),
      release_type: values.release_type,
      upc: toNull(values.upc),
      catalog_number: toNull(values.catalog_number),
      label_id: label?.id ?? null,
      display_artist: toNull(values.display_artist),
      release_date: values.release_date || null,
      c_line: toNull(values.c_line),
      notes: toNull(values.notes),
      external_ids: externalIdsPayload(externalIds),
      status: values.status,
      tracks: toTrackPayload(tracks),
    };
    save(body, allowDuplicate);
  };

  const statusOptions = (release ? (["active", "draft", "archived"] as const) : (["active", "draft"] as const)).map((value) => ({ value, label: codeLabel(value) }));

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submitForm();
      }}
      noValidate className="space-y-5">
      <SaveErrorAlert error={saveError} entity="release" onSaveAnyway={() => submitForm(true)} pending={pending} mode={release ? "edit" : "create"} />
      <FormSection title="Release" description="An album, EP or single as delivered to stores.">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField label="Title" required error={errors.title}>
            <Input value={values.title} onChange={(event) => set("title", event.target.value)} maxLength={255} autoFocus={!release} />
          </FormField>
          <FormField label="Type" error={errors.release_type}>
            {(field) => (
              <Select {...field} value={values.release_type} onValueChange={(value) => set("release_type", value)} options={RELEASE_TYPES.map((value) => ({ value, label: codeLabel(value) }))} />
            )}
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="UPC / EAN" hint="12–14 digits, GS1 check digit verified." error={errors.upc}>
            <Input value={values.upc} onChange={(event) => set("upc", event.target.value)} inputMode="numeric" className="font-mono" placeholder="012345678905" autoComplete="off" />
          </FormField>
          <FormField label="Catalog number" error={errors.catalog_number}>
            <Input value={values.catalog_number} onChange={(event) => set("catalog_number", event.target.value)} maxLength={50} className="font-mono" />
          </FormField>
          <FormField label="Release date" error={errors.release_date}>
            <Input type="date" value={values.release_date} onChange={(event) => set("release_date", event.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Label" error={errors.label_id}>
            {(field) => (
              <div className="flex gap-2">
                <CatalogPicker
                  {...field}
                  orgId={orgId}
                  entity="party"
                  selectedId={label?.id ?? null}
                  selectedLabel={label?.name ?? null}
                  placeholder="Search labels"
                  onSelect={(party) => setLabel({ id: party.id, name: (party as Party).name })}
                  onCreateRequest={setCreatingLabel}
                  createLabel="Create label"
                />
                {label ? <IconButton label="Clear label" icon={<X aria-hidden />} variant="outline" onClick={() => setLabel(null)} /> : null}
              </div>
            )}
          </FormField>
          <FormField label="Display artist" error={errors.display_artist}>
            <Input value={values.display_artist} onChange={(event) => set("display_artist", event.target.value)} maxLength={255} />
          </FormField>
        </div>
        <FormField label="© line" hint="e.g. 2021 Example Records" error={errors.c_line}>
          <Input value={values.c_line} onChange={(event) => set("c_line", event.target.value)} maxLength={255} />
        </FormField>
      </FormSection>

      <FormSection title="Track list" description="Add recordings, then reorder them or move them to another disc. Track numbers follow the order.">
        <TrackListEditor orgId={orgId} rows={tracks} onChange={setTracks} serverError={errors.tracks} />
      </FormSection>

      <FormSection title="External identifiers" description="Store and distributor identifiers for this release.">
        <ExternalIdsEditor rows={externalIds} onChange={setExternalIds} errors={errors} showErrors={true} />
      </FormSection>

      <FormSection title="Status & notes">
        <FormField label="Status" error={errors.status} className="sm:max-w-xs">
          {(field) => <Select {...field} value={values.status} onValueChange={(value) => set("status", value)} options={statusOptions} />}
        </FormField>
        <FormField label="Internal notes" error={errors.notes}>
          <Textarea rows={3} maxLength={10000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
        </FormField>
      </FormSection>

      <SubmitBar cancelHref={release ? entityHref("release", release.id) : entityHref("release")} submitLabel={release ? "Save changes" : "Create release"} pending={pending} />
      <QuickPartyDialog
        orgId={orgId}
        initialName={creatingLabel}
        defaultRoles={["label"]}
        defaultType="company"
        onClose={() => setCreatingLabel(null)}
        onCreated={(party) => setLabel({ id: party.id, name: party.name })}
      />
    </form>
  );
}
