"use client";

import { FileText, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { CatalogPicker } from "@/components/catalog/catalog-picker";
import { ContributorsEditor } from "@/components/catalog/contributors-editor";
import { FormSection, SaveErrorAlert, SubmitBar } from "@/components/catalog/form-shell";
import { externalIdsPayload, rowsFromExternalIds, validateExternalIds, type ExternalIdRow } from "@/components/catalog/external-ids";
import { ExternalIdsEditor } from "@/components/catalog/external-ids-editor";
import { contributorRowErrors, omitKey, toNull, type ContributorRow } from "@/components/catalog/form-utils";
import { formatDuration, formatIsrc, formatIswc, identifierError, parseDuration } from "@/components/catalog/identifiers";
import { codeLabel, entityHref } from "@/components/catalog/labels";
import { QuickPartyDialog } from "@/components/catalog/quick-party-dialog";
import { useCatalogSave } from "@/components/catalog/use-catalog-save";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  RECORDING_CONTRIBUTOR_ROLES,
  type CatalogStatus,
  type Party,
  type PartyRole,
  type RecordingContributorRole,
  type RecordingDetail,
  type RecordingInput,
  type VerificationStatus,
  type Work,
} from "@/lib/api/hooks/catalog";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";

export interface RecordingValues {
  title: string;
  version_title: string;
  isrc: string;
  internal_code: string;
  display_artist: string;
  duration: string;
  recording_date: string;
  p_line: string;
  is_explicit: boolean;
  notes: string;
  status: CatalogStatus;
  verification_status: VerificationStatus;
}

export function validateRecording(values: RecordingValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.title.trim()) errors.title = "This field is required";
  else if (values.title.trim().length > 255) errors.title = "Ensure this value has at most 255 characters";
  const isrc = identifierError("isrc", values.isrc);
  if (isrc) errors.isrc = isrc;
  if (values.internal_code.trim().length > 50) errors.internal_code = "Ensure this value has at most 50 characters";
  const duration = parseDuration(values.duration);
  if (duration !== null && (Number.isNaN(duration) || duration > 86400)) errors.duration_seconds = "Use m:ss, h:mm:ss or seconds (max 24 hours)";
  if (values.recording_date && !/^\d{4}-\d{2}-\d{2}$/.test(values.recording_date)) errors.recording_date = "Enter a valid date";
  return errors;
}

function partyRolesFor(role: RecordingContributorRole): PartyRole[] {
  if (role === "main_artist" || role === "featured_artist" || role === "vocalist") return ["artist"];
  if (role === "producer" || role === "co_producer") return ["producer"];
  if (role === "mixer" || role === "engineer" || role === "mastering_engineer") return ["engineer"];
  if (role === "musician") return ["performer"];
  return ["label"];
}

interface LinkedWorkChip {
  id: string;
  title: string;
  iswc: string | null;
}

export function RecordingForm({ orgId, recording }: { orgId: string; recording?: RecordingDetail }) {
  const [values, setValues] = useState<RecordingValues>(() => ({
    title: recording?.title ?? "",
    version_title: recording?.version_title ?? "",
    isrc: recording?.isrc ? formatIsrc(recording.isrc) : "",
    internal_code: recording?.internal_code ?? "",
    display_artist: recording?.display_artist ?? "",
    duration: recording?.duration_seconds ? formatDuration(recording.duration_seconds) : "",
    recording_date: recording?.recording_date ?? "",
    p_line: recording?.p_line ?? "",
    is_explicit: recording?.is_explicit ?? false,
    notes: recording?.notes ?? "",
    status: (recording?.status as CatalogStatus) ?? "active",
    verification_status: (recording?.verification_status as VerificationStatus) ?? "unverified",
  }));
  const [artist, setArtist] = useState<{ id: string; name: string } | null>(() =>
    recording?.primary_artist_id ? { id: recording.primary_artist_id, name: recording.primary_artist_name ?? "Unknown party" } : null,
  );
  const [creatingArtist, setCreatingArtist] = useState<string | null>(null);
  const [contributors, setContributors] = useState<ContributorRow[]>(() =>
    (recording?.contributors ?? []).map((c) => ({
      key: c.id,
      party_id: c.party_id,
      party_name: c.party_name ?? "Unknown party",
      role: c.role,
      instrument: c.instrument ?? "",
    })),
  );
  const [works, setWorks] = useState<LinkedWorkChip[]>(() => (recording?.works ?? []).map((w) => ({ id: w.id, title: w.title, iswc: w.iswc })));
  const [externalIds, setExternalIds] = useState<ExternalIdRow[]>(() => rowsFromExternalIds(recording?.external_ids));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const { save, pending, saveError } = useCatalogSave(orgId, "recording", recording?.id ?? null, setErrors);
  const dirty = useIsDirty({ values, artist, contributors, works, externalIds });
  useUnsavedChangesWarning(dirty);

  const set = <K extends keyof RecordingValues>(key: K, value: RecordingValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => omitKey(omitKey(current, key), key === "duration" ? "duration_seconds" : key));
  };

  const submitForm = (allowDuplicate = false) => {
    setSubmitted(true);
    const clientErrors = validateRecording(values);
    const extErrors = validateExternalIds(externalIds);
    setErrors({ ...clientErrors, ...extErrors });
    if (Object.keys(clientErrors).length > 0 || Object.keys(contributorRowErrors(contributors)).length > 0 || Object.keys(extErrors).length > 0) return;
    const body: RecordingInput = {
      title: values.title.trim(),
      version_title: toNull(values.version_title),
      isrc: toNull(values.isrc),
      internal_code: toNull(values.internal_code),
      primary_artist_id: artist?.id ?? null,
      display_artist: toNull(values.display_artist),
      duration_seconds: parseDuration(values.duration),
      recording_date: values.recording_date || null,
      p_line: toNull(values.p_line),
      is_explicit: values.is_explicit,
      notes: toNull(values.notes),
      external_ids: externalIdsPayload(externalIds),
      status: values.status,
      verification_status: values.verification_status,
      contributors: contributors.map((row) => ({ party_id: row.party_id, role: row.role as RecordingContributorRole, instrument: toNull(row.instrument) })),
      work_ids: works.map((work) => work.id),
    };
    save(body, allowDuplicate);
  };

  const statusOptions = (recording ? (["active", "draft", "archived"] as const) : (["active", "draft"] as const)).map((value) => ({ value, label: codeLabel(value) }));

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submitForm();
      }}
      noValidate className="space-y-5">
      <SaveErrorAlert error={saveError} entity="recording" onSaveAnyway={() => submitForm(true)} pending={pending} mode={recording ? "edit" : "create"} />
      <FormSection title="Recording" description="The sound recording (master) and its identifiers.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Title" required error={errors.title}>
            <Input value={values.title} onChange={(event) => set("title", event.target.value)} maxLength={255} autoFocus={!recording} />
          </FormField>
          <FormField label="Version" hint="e.g. Radio Edit, Remastered 2021" error={errors.version_title}>
            <Input value={values.version_title} onChange={(event) => set("version_title", event.target.value)} maxLength={255} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="ISRC" hint="12 characters: CC-XXX-YY-NNNNN" error={errors.isrc}>
            <Input
              value={values.isrc}
              onChange={(event) => set("isrc", event.target.value)}
              onBlur={() => {
                if (values.isrc.trim() && !identifierError("isrc", values.isrc)) set("isrc", formatIsrc(values.isrc));
              }}
              placeholder="US-RC1-76-07839"
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
          <FormField label="Duration" hint="m:ss" error={errors.duration_seconds}>
            <Input value={values.duration} onChange={(event) => set("duration", event.target.value)} placeholder="3:45" inputMode="numeric" />
          </FormField>
          <FormField label="Recording date" error={errors.recording_date}>
            <Input type="date" value={values.recording_date} onChange={(event) => set("recording_date", event.target.value)} />
          </FormField>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recording-explicit">Explicit</Label>
            <div className="flex h-9 items-center gap-2">
              <Switch id="recording-explicit" checked={values.is_explicit} onCheckedChange={(checked) => set("is_explicit", checked)} />
              <span className="text-[13px] text-fg-muted">{values.is_explicit ? "Explicit content" : "Clean"}</span>
            </div>
          </div>
        </div>
        <FormField label="℗ line" hint="e.g. 2021 Example Records" error={errors.p_line}>
          <Input value={values.p_line} onChange={(event) => set("p_line", event.target.value)} maxLength={255} />
        </FormField>
      </FormSection>

      <FormSection title="Artist" description="Link the main artist party; the display artist is the credit as printed.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Primary artist" error={errors.primary_artist_id}>
            {(field) => (
              <div className="flex gap-2">
                <CatalogPicker
                  {...field}
                  orgId={orgId}
                  entity="party"
                  selectedId={artist?.id ?? null}
                  selectedLabel={artist?.name ?? null}
                  placeholder="Search artists"
                  onSelect={(party) => setArtist({ id: party.id, name: (party as Party).name })}
                  onCreateRequest={setCreatingArtist}
                  createLabel="Create artist"
                />
                {artist ? (
                  <Button variant="ghost" size="md" onClick={() => setArtist(null)} aria-label="Clear primary artist">
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            )}
          </FormField>
          <FormField label="Display artist" hint="Overrides the party name in credits." error={errors.display_artist}>
            <Input value={values.display_artist} onChange={(event) => set("display_artist", event.target.value)} maxLength={255} placeholder={artist?.name ?? "The Example Band feat. Guest"} />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Contributors" description="Performers, producers and engineers credited on this recording.">
        <ContributorsEditor
          orgId={orgId}
          label="Contributors"
          roles={RECORDING_CONTRIBUTOR_ROLES}
          defaultRole="main_artist"
          rows={contributors}
          onChange={setContributors}
          withInstrument
          partyRolesFor={partyRolesFor}
          serverErrors={errors}
          showErrors={submitted}
        />
      </FormSection>

      <FormSection title="Underlying works" description="The compositions embodied in this recording. Needed for publishing royalties.">
        <CatalogPicker
          orgId={orgId}
          entity="work"
          aria-label="Link a work"
          placeholder="Search works by title, ISWC or code"
          excludeIds={works.map((work) => work.id)}
          onSelect={(item) => {
            const work = item as Work;
            setWorks((current) => [...current, { id: work.id, title: work.title, iswc: work.iswc }]);
          }}
        />
        {works.length === 0 ? (
          <p className="text-[13px] text-fg-muted">No linked works. Recordings without a work are flagged by validation.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Linked works">
            {works.map((work) => (
              <li key={work.id} className="flex items-center gap-3 px-3 py-2">
                <FileText className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link href={entityHref("work", work.id)} target="_blank" className="block truncate text-sm font-medium text-fg hover:text-primary hover:underline">
                    {work.title}
                  </Link>
                  <p className="font-mono text-xs text-fg-subtle">{work.iswc ? formatIswc(work.iswc) : "No ISWC"}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setWorks((current) => current.filter((candidate) => candidate.id !== work.id))}>
                  Unlink<span className="sr-only"> {work.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {errors.work_ids ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {errors.work_ids}
          </p>
        ) : null}
      </FormSection>

      <FormSection title="External identifiers" description="Platform identifiers for this recording (e.g. Spotify or Apple Music ids).">
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
        <FormField label="Internal notes" error={errors.notes}>
          <Textarea rows={3} maxLength={10000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
        </FormField>
      </FormSection>

      <SubmitBar
        cancelHref={recording ? entityHref("recording", recording.id) : entityHref("recording")}
        submitLabel={recording ? "Save changes" : "Create recording"}
        pending={pending}
      />
      <QuickPartyDialog
        orgId={orgId}
        initialName={creatingArtist}
        defaultRoles={["artist"]}
        onClose={() => setCreatingArtist(null)}
        onCreated={(party) => setArtist({ id: party.id, name: party.name })}
      />
    </form>
  );
}
