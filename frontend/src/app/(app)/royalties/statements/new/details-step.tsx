"use client";

import { FileUp, Upload } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { useRoyaltyReference, useUploadStatement } from "@/lib/api/hooks/royalties";

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPTED = [".csv", ".tsv", ".txt", ".xlsx"];

interface FormState {
  source_name: string;
  source_category: string;
  period_start: string;
  period_end: string;
  currency: string;
  default_rights_type: string;
  reported_total: string;
  notes: string;
}

type Errors = Partial<Record<keyof FormState | "file", string>>;

function validate(form: FormState, file: File | null): Errors {
  const errors: Errors = {};
  if (!form.source_name.trim()) errors.source_name = "Enter the source name (e.g. the distributor)";
  else if (form.source_name.trim().length > 120) errors.source_name = "Use at most 120 characters";
  if (!form.source_category) errors.source_category = "Choose the income source category";
  if (!form.period_start) errors.period_start = "Enter the period start date";
  if (!form.period_end) errors.period_end = "Enter the period end date";
  if (form.period_start && form.period_end && form.period_end < form.period_start) errors.period_end = "Period end must be on or after the start";
  if (!/^[A-Z]{3}$/.test(form.currency)) errors.currency = "Choose a 3-letter currency code";
  const total = validateAmount(form.reported_total, { required: false, allowNegative: true, allowZero: true, maxDecimals: 8 });
  if (total) errors.reported_total = total;
  if (form.notes.length > 5000) errors.notes = "Use at most 5,000 characters";
  if (!file) errors.file = "Choose the statement file";
  else if (!ACCEPTED.some((ext) => file.name.toLowerCase().endsWith(ext))) errors.file = "Upload a CSV, TSV, TXT or XLSX file";
  else if (file.size > MAX_BYTES) errors.file = "The file is larger than 25 MB";
  else if (file.size === 0) errors.file = "The file is empty";
  return errors;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DetailsStep({ orgId, defaultCurrency, onUploaded }: { orgId: string; defaultCurrency: string; onUploaded: (statementId: string) => void }) {
  const categories = useRoyaltyReference("source-categories");
  const rightsTypes = useRoyaltyReference("rights-types");
  const currencies = useCurrencyCodes();
  const upload = useUploadStatement(orgId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [form, setForm] = useState<FormState>({
    source_name: "",
    source_category: "",
    period_start: "",
    period_end: "",
    currency: defaultCurrency || "USD",
    default_rights_type: "",
    reported_total: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);
  const [duplicate, setDuplicate] = useState<{ id: string; status: string | null } | null>(null);
  const [formError, setFormError] = useState<{ message: string; billing?: boolean } | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (submitted) setErrors(validate(next, file));
  };

  const pickFile = (next: File | null) => {
    setFile(next);
    setDuplicate(null);
    if (next && !form.source_name) {
      // Friendly default: "acme-sales-2026-03.csv" → "acme sales 2026 03".
      const guess = next.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
      setForm((current) => ({ ...current, source_name: current.source_name || guess }));
    }
    if (submitted) setErrors(validate(form, next));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setDuplicate(null);
    setFormError(null);
    const found = validate(form, file);
    setErrors(found);
    if (Object.keys(found).length > 0 || !file) return;
    try {
      const statement = await upload.mutateAsync({
        file,
        source_name: form.source_name.trim(),
        source_category: form.source_category,
        period_start: form.period_start,
        period_end: form.period_end,
        currency: form.currency,
        default_rights_type: form.default_rights_type || undefined,
        reported_total: form.reported_total ? normalizeAmountInput(form.reported_total) : undefined,
        notes: form.notes.trim() || undefined,
      });
      toast.success("Statement uploaded", { description: `${statement.total_rows.toLocaleString()} rows detected. Review the column mapping next.` });
      onUploaded(statement.id);
    } catch (error) {
      if (isApiError(error) && error.code === "duplicate_statement") {
        const details = (error.details ?? {}) as { statement_id?: string; status?: string };
        if (details.statement_id) setDuplicate({ id: details.statement_id, status: details.status ?? null });
        else setFormError({ message: error.message });
        return;
      }
      if (isApiError(error) && error.isValidation) {
        const mapped = fieldErrors(error);
        setErrors((current) => ({ ...current, ...mapped }));
        if (Object.keys(mapped).length === 0) setFormError({ message: errorMessage(error) });
        return;
      }
      if (isApiError(error) && (error.code === "plan_limit_exceeded" || error.status === 402)) {
        setFormError({ message: error.message, billing: true });
        return;
      }
      setFormError({ message: errorMessage(error) });
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader title="Statement details" description="Describe where the money came from. These details drive default rights types and reconciliation." />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <FormField label="Source name" required error={errors.source_name} hint="The distributor, DSP, society or publisher that issued the statement." className="sm:col-span-2">
              <Input value={form.source_name} maxLength={120} onChange={(e) => set("source_name", e.target.value)} placeholder="e.g. DistroKid, Spotify, ASCAP" />
            </FormField>
            <FormField label="Source category" required error={errors.source_category}>
              {(props) => (
                <Select
                  {...props}
                  value={form.source_category || undefined}
                  onValueChange={(v) => set("source_category", v)}
                  placeholder={categories.isLoading ? "Loading…" : "Choose a category"}
                  options={(categories.data ?? []).map((c) => ({ value: c.code, label: c.name }))}
                />
              )}
            </FormField>
            <FormField label="Default rights type" hint="Used when lines don't state one. Leave empty to use the category default (e.g. streaming → master).">
              {(props) => (
                <Select
                  {...props}
                  value={form.default_rights_type || "auto"}
                  onValueChange={(v) => set("default_rights_type", v === "auto" ? "" : v)}
                  options={[{ value: "auto", label: "Category default" }, ...(rightsTypes.data ?? []).map((r) => ({ value: r.code, label: r.name }))]}
                />
              )}
            </FormField>
            <FormField label="Period start" required error={errors.period_start}>
              <Input type="date" value={form.period_start} onChange={(e) => set("period_start", e.target.value)} />
            </FormField>
            <FormField label="Period end" required error={errors.period_end}>
              <Input type="date" value={form.period_end} min={form.period_start || undefined} onChange={(e) => set("period_end", e.target.value)} />
            </FormField>
            <FormField label="Statement currency" required error={errors.currency} hint="Lines without their own currency use this one.">
              {(props) => <Select {...props} value={form.currency} onValueChange={(v) => set("currency", v)} options={currencies.map((code) => ({ value: code, label: code }))} />}
            </FormField>
            <FormField label="Reported total" error={errors.reported_total} hint="The total printed on the statement, used to reconcile. Exact decimal, e.g. 71.41.">
              <Input inputMode="decimal" value={form.reported_total} onChange={(e) => set("reported_total", e.target.value)} placeholder="Optional" />
            </FormField>
            <FormField label="Notes" error={errors.notes} className="sm:col-span-2">
              <Textarea rows={3} value={form.notes} maxLength={5000} onChange={(e) => set("notes", e.target.value)} placeholder="Optional internal notes" />
            </FormField>
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Statement file" description="CSV, TSV, TXT or XLSX · up to 25 MB and 250,000 rows." />
            <CardBody>
              <div
                className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
                  dragging ? "border-primary bg-primary-soft/40" : errors.file ? "border-danger/60" : "border-border-strong"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pickFile(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                <FileUp className="size-8 text-fg-subtle" aria-hidden />
                {file ? (
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-fg-subtle">{formatBytes(file.size)}</p>
                  </div>
                ) : (
                  <p className="text-[13px] text-fg-muted">Drag a file here, or</p>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  {file ? "Choose another file" : "Choose file"}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPTED.join(",")}
                  className="sr-only"
                  aria-label="Statement file"
                  aria-invalid={errors.file ? true : undefined}
                  aria-describedby={errors.file ? "file-error" : undefined}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {errors.file ? (
                <p id="file-error" role="alert" className="mt-2 text-xs font-medium text-danger">
                  {errors.file}
                </p>
              ) : null}
            </CardBody>
          </Card>
          {duplicate ? (
            <Alert
              tone="warning"
              title="This exact file was already imported"
              action={
                <ButtonLink href={`/royalties/statements/${duplicate.id}`} size="sm" variant="outline">
                  Open existing statement
                </ButtonLink>
              }
            >
              Uploading it again would double count income. {duplicate.status ? `The existing statement is ${duplicate.status}.` : null}
            </Alert>
          ) : null}
          {formError ? (
            <Alert tone="danger" title="Upload failed">
              {formError.message}{" "}
              {formError.billing ? (
                <Link href="/settings/billing" className="font-medium underline">
                  Review your plan
                </Link>
              ) : null}
            </Alert>
          ) : null}
        </div>
      </div>
      <CardFooter className="mt-6 rounded-xl border">
        <ButtonLink href="/royalties/statements" variant="outline">
          Cancel
        </ButtonLink>
        <Button type="submit" loading={upload.isPending} leftIcon={<Upload aria-hidden />}>
          Upload & continue
        </Button>
      </CardFooter>
    </form>
  );
}
