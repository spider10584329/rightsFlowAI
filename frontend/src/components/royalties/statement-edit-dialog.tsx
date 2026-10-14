"use client";

import { useState, type FormEvent } from "react";

import {
  affectsCalculation,
  buildStatementPatch,
  formFromStatement,
  validateStatementEdit,
  type StatementEditErrors,
  type StatementEditForm,
} from "@/components/royalties/statement-edit";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { useRoyaltyReference, useUpdateStatement, type Statement } from "@/lib/api/hooks/royalties";

export function StatementEditDialog({
  orgId,
  statement,
  open,
  onOpenChange,
}: {
  orgId: string;
  statement: Statement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        {/* Remount per opening so the form starts from the latest saved values. */}
        {open ? <EditForm key={statement.updated_at} orgId={orgId} statement={statement} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </DialogRoot>
  );
}

function EditForm({ orgId, statement, onDone }: { orgId: string; statement: Statement; onDone: () => void }) {
  const update = useUpdateStatement(orgId);
  const categories = useRoyaltyReference("source-categories");
  const rightsTypes = useRoyaltyReference("rights-types");
  const currencies = useCurrencyCodes();
  const [form, setForm] = useState<StatementEditForm>(() => formFromStatement(statement));
  const [errors, setErrors] = useState<StatementEditErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Lines carry the statement currency once processed, so currency is fixed after that.
  // (valid/error row counts are only filled once lines exist; the backend's 409 is authoritative.)
  const currencyLocked = statement.valid_rows + statement.error_rows > 0 || ["queued", "processing"].includes(statement.status);
  const patch = buildStatementPatch(statement, form);
  const recalculates = affectsCalculation(patch) && statement.status === "calculated";

  const set = <K extends keyof StatementEditForm>(key: K, value: StatementEditForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateStatementEdit(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    update.mutate(
      { statementId: statement.id, body: patch },
      {
        onSuccess: () => {
          toast.success("Statement updated", {
            description: recalculates ? "The unposted calculation was discarded; recalculate when ready." : undefined,
          });
          onDone();
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields as StatementEditErrors);
          if (isApiError(error) && error.code === "currency_locked") {
            setErrors({ currency: error.message });
          } else if (Object.keys(fields).length === 0) {
            setFormError(errorMessage(error));
          }
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader title="Edit statement details" description="Correct the source, period or reported total. Lines are not changed." />
      <DialogBody className="grid gap-4 sm:grid-cols-2">
        {formError ? (
          <Alert tone="danger" title="Could not save" className="sm:col-span-2">
            {formError}
          </Alert>
        ) : null}
        <FormField label="Source name" required error={errors.source_name} className="sm:col-span-2">
          <Input value={form.source_name} maxLength={120} onChange={(e) => set("source_name", e.target.value)} />
        </FormField>
        <FormField label="Source category" required error={errors.source_category}>
          {(props) => (
            <Select
              {...props}
              value={form.source_category}
              onValueChange={(v) => set("source_category", v)}
              options={(categories.data ?? [{ code: statement.source_category, name: statement.source_category }]).map((c) => ({
                value: c.code,
                label: c.name,
              }))}
            />
          )}
        </FormField>
        <FormField label="Default rights type" hint="Used when lines don't state one.">
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
        <FormField
          label="Statement currency"
          required
          error={errors.currency}
          hint={currencyLocked ? "Locked: processed lines already carry this currency." : undefined}
        >
          {(props) => (
            <Select
              {...props}
              disabled={currencyLocked}
              value={form.currency}
              onValueChange={(v) => set("currency", v)}
              options={(currencies.includes(form.currency) ? currencies : [form.currency, ...currencies]).map((code) => ({ value: code, label: code }))}
            />
          )}
        </FormField>
        <FormField label="Reported total" error={errors.reported_total} hint="Exact decimal printed on the statement. Leave empty to clear.">
          <Input inputMode="decimal" value={form.reported_total} onChange={(e) => set("reported_total", e.target.value)} />
        </FormField>
        <FormField label="Notes" error={errors.notes} className="sm:col-span-2">
          <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </FormField>
        {recalculates ? (
          <Alert tone="warning" title="This changes calculation inputs" className="sm:col-span-2">
            Saving discards the current unposted calculation. Recalculate afterwards.
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={update.isPending}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
