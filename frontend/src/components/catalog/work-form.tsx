"use client";

import { useState, type FormEvent } from "react";

import { ContributorsEditor } from "@/components/catalog/contributors-editor";
import { externalIdsPayload, rowsFromExternalIds, validateExternalIds, type ExternalIdRow } from "@/components/catalog/external-ids";
import { ExternalIdsEditor } from "@/components/catalog/external-ids-editor";
import { FormSection, SaveErrorAlert, SubmitBar } from "@/components/catalog/form-shell";
import { contributorRowErrors, omitKey, toNull, type ContributorRow } from "@/components/catalog/form-utils";
import { formatIswc, identifierError } from "@/components/catalog/identifiers";
import { codeLabel, entityHref } from "@/components/catalog/labels";
import { useCatalogSave } from "@/components/catalog/use-catalog-save";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  WORK_CONTRIBUTOR_ROLES,
  type CatalogStatus,
  type PartyRole,
  type VerificationStatus,
  type WorkContributorRole,
  type WorkDetail,
  type WorkInput,
} from "@/lib/api/hooks/catalog";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";

export interface WorkValues {
  title: string;
  alternate_titles: string;
  iswc: string;
  internal_code: string;
  language: string;
  genre: string;
  creation_year: string;
  lyrics_excerpt: string;
  notes: string;
  status: CatalogStatus;
  verification_status: VerificationStatus;
}

const LANGUAGE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4})?$/;

export function validateWork(values: WorkValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.title.trim()) errors.title = "This field is required";
  else if (values.title.trim().length > 255) errors.title = "Ensure this value has at most 255 characters";
  const iswc = identifierError("iswc", values.iswc);
  if (iswc) errors.iswc = iswc;
  if (values.internal_code.trim().length > 50) errors.internal_code = "Ensure this value has at most 50 characters";
  if (values.language.trim() && !LANGUAGE_RE.test(values.language.trim())) errors.language = "Use a language code such as en, es or pt-BR";
  if (values.creation_year.trim()) {
    const year = Number(values.creation_year);
    if (!Number.isInteger(year) || year < 1000 || year > 2100) errors.creation_year = "Enter a year between 1000 and 2100";
  }
  const alternates = splitLines(values.alternate_titles);
  if (alternates.length > 50) errors.alternate_titles = "At most 50 alternate titles are allowed";
  else if (alternates.some((title) => title.length > 255)) errors.alternate_titles = "Each title must be at most 255 characters";
  return errors;
}

function splitLines(value: string): string[] {
  return value
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Suggested party roles when a contributor is created inline. */
function partyRolesFor(role: WorkContributorRole): PartyRole[] {
  if (role === "composer") return ["songwriter", "composer"];
  if (role === "lyricist") return ["songwriter", "lyricist"];
  if (role === "composer_lyricist") return ["songwriter", "composer", "lyricist"];
  if (role === "original_publisher" || role === "sub_publisher") return ["publisher"];
  if (role === "administrator") return ["administrator"];
  return ["songwriter"];
}

function initialValues(work?: WorkDetail): WorkValues {
  return {
    title: work?.title ?? "",
    alternate_titles: (work?.alternate_titles ?? []).join("\n"),
    iswc: work?.iswc ? formatIswc(work.iswc) : "",
    internal_code: work?.internal_code ?? "",
    language: work?.language ?? "",
    genre: work?.genre ?? "",
    creation_year: work?.creation_year ? String(work.creation_year) : "",
    lyrics_excerpt: work?.lyrics_excerpt ?? "",
    notes: work?.notes ?? "",
    status: (work?.status as CatalogStatus) ?? "active",
    verification_status: (work?.verification_status as VerificationStatus) ?? "unverified",
  };
}

export function WorkForm({ orgId, work }: { orgId: string; work?: WorkDetail }) {
  const [values, setValues] = useState<WorkValues>(() => initialValues(work));
  const [contributors, setContributors] = useState<ContributorRow[]>(() =>
    (work?.contributors ?? []).map((c) => ({ key: c.id, party_id: c.party_id, party_name: c.party_name ?? "Unknown party", role: c.role })),
  );
  const [externalIds, setExternalIds] = useState<ExternalIdRow[]>(() => rowsFromExternalIds(work?.external_ids));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const { save, pending, saveError } = useCatalogSave(orgId, "work", work?.id ?? null, setErrors);
  const dirty = useIsDirty({ values, contributors, externalIds });
  useUnsavedChangesWarning(dirty);

  const set = <K extends keyof WorkValues>(key: K, value: WorkValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => omitKey(current, key));
  };

  const submitForm = (allowDuplicate = false) => {
    setSubmitted(true);
    const clientErrors = validateWork(values);
    const rowErrors = contributorRowErrors(contributors);
    const extErrors = validateExternalIds(externalIds);
    setErrors({ ...clientErrors, ...extErrors });
    if (Object.keys(clientErrors).length > 0 || Object.keys(rowErrors).length > 0 || Object.keys(extErrors).length > 0) return;
    const alternates = splitLines(values.alternate_titles);
    const body: WorkInput = {
      title: values.title.trim(),
      alternate_titles: alternates.length > 0 ? alternates : null,
      iswc: toNull(values.iswc),
      internal_code: toNull(values.internal_code),
      language: toNull(values.language),
      genre: toNull(values.genre),
      creation_year: values.creation_year.trim() ? Number(values.creation_year) : null,
      lyrics_excerpt: toNull(values.lyrics_excerpt),
      notes: toNull(values.notes),
      external_ids: externalIdsPayload(externalIds),
      status: values.status,
      verification_status: values.verification_status,
      contributors: contributors.map((row) => ({ party_id: row.party_id, role: row.role as WorkContributorRole })),
    };
    save(body, allowDuplicate);
  };

  const statusOptions = (work ? (["active", "draft", "archived"] as const) : (["active", "draft"] as const)).map((value) => ({ value, label: codeLabel(value) }));

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submitForm();
      }}
      noValidate className="space-y-5">
      <SaveErrorAlert error={saveError} entity="work" onSaveAnyway={() => submitForm(true)} pending={pending} mode={work ? "edit" : "create"} />
      <FormSection title="Composition" description="The musical work (song) as registered with societies.">
        <FormField label="Title" required error={errors.title}>
          <Input value={values.title} onChange={(event) => set("title", event.target.value)} maxLength={255} autoFocus={!work} />
        </FormField>
        <FormField label="Alternate titles" hint="One per line (AKAs, translated titles)." error={errors.alternate_titles}>
          <Textarea rows={2} value={values.alternate_titles} onChange={(event) => set("alternate_titles", event.target.value)} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="ISWC" hint="Format T-123.456.789-C. The check digit is verified." error={errors.iswc}>
            <Input
              value={values.iswc}
              onChange={(event) => set("iswc", event.target.value)}
              onBlur={() => {
                if (values.iswc.trim() && !identifierError("iswc", values.iswc)) set("iswc", formatIswc(values.iswc));
              }}
              placeholder="T-034.524.680-1"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Internal code" hint="Unique within your catalog." error={errors.internal_code}>
            <Input value={values.internal_code} onChange={(event) => set("internal_code", event.target.value)} maxLength={50} className="font-mono" />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Language" hint="ISO code, e.g. en" error={errors.language}>
            <Input value={values.language} onChange={(event) => set("language", event.target.value)} maxLength={10} />
          </FormField>
          <FormField label="Genre" error={errors.genre}>
            <Input value={values.genre} onChange={(event) => set("genre", event.target.value)} maxLength={100} />
          </FormField>
          <FormField label="Creation year" error={errors.creation_year}>
            <Input type="number" inputMode="numeric" min={1000} max={2100} value={values.creation_year} onChange={(event) => set("creation_year", event.target.value)} />
          </FormField>
        </div>
      </FormSection>

      <FormSection
        title="Writers & publishers"
        description="Composers, lyricists and publishers. Search existing parties or create one inline."
      >
        <ContributorsEditor
          orgId={orgId}
          label="Contributors"
          roles={WORK_CONTRIBUTOR_ROLES}
          defaultRole="composer_lyricist"
          rows={contributors}
          onChange={setContributors}
          partyRolesFor={partyRolesFor}
          serverErrors={errors}
          showErrors={submitted}
        />
        {errors.contributors && !Object.keys(errors).some((key) => key.startsWith("contributors.")) ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.contributors}
          </p>
        ) : null}
      </FormSection>

      <FormSection title="External identifiers" description="Platform and society identifiers for this work (e.g. MLC song code, PRS tune code).">
        <ExternalIdsEditor rows={externalIds} onChange={setExternalIds} errors={errors} showErrors={submitted} />
      </FormSection>

      <FormSection title="Status & notes">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Status" error={errors.status}>
            {(field) => <Select {...field} value={values.status} onValueChange={(value) => set("status", value)} options={statusOptions} />}
          </FormField>
          <FormField label="Verification" error={errors.verification_status}>
            {(field) => (
              <Select
                {...field}
                value={values.verification_status}
                onValueChange={(value) => set("verification_status", value)}
                options={(["unverified", "verified", "disputed"] as const).map((value) => ({ value, label: codeLabel(value) }))}
              />
            )}
          </FormField>
        </div>
        <FormField label="Lyrics excerpt" error={errors.lyrics_excerpt}>
          <Textarea rows={3} maxLength={5000} value={values.lyrics_excerpt} onChange={(event) => set("lyrics_excerpt", event.target.value)} />
        </FormField>
        <FormField label="Internal notes" error={errors.notes}>
          <Textarea rows={3} maxLength={10000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
        </FormField>
      </FormSection>

      <SubmitBar cancelHref={work ? entityHref("work", work.id) : entityHref("work")} submitLabel={work ? "Save changes" : "Create work"} pending={pending} />
    </form>
  );
}
