"use client";

import { Copy, Link2, Plus, Save, ShieldAlert, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  emptyLine,
  manualLinesTotal,
  mapManualApiErrors,
  toLinePayload,
  validateManualLines,
  MAX_MANUAL_LINES,
  type ManualLineDraft,
  type ManualLineErrors,
} from "@/components/royalties/manual-lines";
import { CatalogSearch, type CatalogSelection } from "@/components/royalties/match-dialog";
import { compareDecimals, normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import { Money } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { isApiError } from "@/lib/api/errors";
import { useCurrencyCodes, useReferenceList } from "@/lib/api/hooks/reference";
import { useCreateManualStatement, useRoyaltyReference } from "@/lib/api/hooks/royalties";
import { useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";
import { cn } from "@/lib/utils";

interface Meta {
  source_name: string;
  source_category: string;
  period_start: string;
  period_end: string;
  currency: string;
  default_rights_type: string;
  reported_total: string;
  notes: string;
}

type MetaErrors = Partial<Record<keyof Meta, string>>;

/** Categories a manual statement is normally used for; the rest stay available. */
const PREFERRED = ["manual_adjustment", "licensing"];

function validateMeta(meta: Meta): MetaErrors {
  const errors: MetaErrors = {};
  if (!meta.source_name.trim()) errors.source_name = "Enter a source name (e.g. the licensee or “Q1 adjustments”)";
  else if (meta.source_name.trim().length > 120) errors.source_name = "Use at most 120 characters";
  if (!meta.source_category) errors.source_category = "Choose a category";
  if (!meta.period_start) errors.period_start = "Enter the period start date";
  if (!meta.period_end) errors.period_end = "Enter the period end date";
  if (meta.period_start && meta.period_end && meta.period_end < meta.period_start) errors.period_end = "Period end must be on or after the start";
  if (!/^[A-Z]{3}$/.test(meta.currency)) errors.currency = "Choose a 3-letter currency code";
  const total = validateAmount(meta.reported_total, { required: false, allowNegative: true, allowZero: true, maxDecimals: 8 });
  if (total) errors.reported_total = total;
  if (meta.notes.length > 5000) errors.notes = "Use at most 5,000 characters";
  return errors;
}

export function ManualStatementClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const categories = useRoyaltyReference("source-categories");
  const rightsTypes = useRoyaltyReference("rights-types");
  const territories = useReferenceList("territories");
  const currencies = useCurrencyCodes();
  const create = useCreateManualStatement(org.id);
  const [meta, setMeta] = useState<Meta>({
    source_name: "",
    source_category: "manual_adjustment",
    period_start: "",
    period_end: "",
    currency: org.defaultCurrency || "USD",
    default_rights_type: "",
    reported_total: "",
    notes: "",
  });
  const [lines, setLines] = useState<ManualLineDraft[]>(() => [emptyLine()]);
  const [submitted, setSubmitted] = useState(false);
  const [serverRows, setServerRows] = useState<Record<number, ManualLineErrors>>({});
  const [serverMeta, setServerMeta] = useState<MetaErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const dirty = useIsDirty({ meta, lines });
  useUnsavedChangesWarning(dirty);

  if (!can("manager")) {
    return (
      <>
        <PageHeader title="Manual statement" breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: "Manual" }]} />
        <Card>
          <EmptyState
            icon={<ShieldAlert aria-hidden />}
            title="Managers record manual statements"
            description="Your role can view statements but not create them."
            action={
              <ButtonLink href="/royalties/statements" variant="outline" size="sm">
                Back to statements
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  const metaErrors: MetaErrors = submitted ? { ...validateMeta(meta), ...serverMeta } : serverMeta;
  const validation = validateManualLines(lines);
  const rowErrors = (index: number): ManualLineErrors => ({ ...(submitted ? validation.rows[index] : {}), ...serverRows[index] });
  const totals = manualLinesTotal(lines);
  const totalMatchesReported =
    meta.reported_total && !validateAmount(meta.reported_total, { allowNegative: true, allowZero: true }) ? normalizeAmountInput(meta.reported_total) : null;

  const setField = <K extends keyof Meta>(key: K, value: Meta[K]) => {
    setMeta((current) => ({ ...current, [key]: value }));
    setServerMeta((current) => ({ ...current, [key]: undefined }));
  };

  const updateLine = (index: number, patch: Partial<ManualLineDraft>) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
    if (serverRows[index]) {
      setServerRows((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
    }
  };

  const removeLine = (index: number) => {
    setLines((current) => current.filter((_, i) => i !== index));
    setServerRows({});
  };

  const duplicateLine = (index: number) => {
    setLines((current) => [...current.slice(0, index + 1), { ...current[index], key: emptyLine().key }, ...current.slice(index + 1)]);
    setServerRows({});
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setGeneral([]);
    setServerRows({});
    setServerMeta({});
    const metaProblems = validateMeta(meta);
    if (Object.keys(metaProblems).length > 0 || !validation.valid) {
      toast.error("Fix the highlighted fields", { description: validation.errors[0] ?? "Some details or lines are invalid." });
      return;
    }
    try {
      const statement = await create.mutateAsync({
        source_name: meta.source_name.trim(),
        source_category: meta.source_category,
        period_start: meta.period_start,
        period_end: meta.period_end,
        currency: meta.currency,
        default_rights_type: meta.default_rights_type || null,
        reported_total: meta.reported_total ? normalizeAmountInput(meta.reported_total) : null,
        notes: meta.notes.trim() || null,
        lines: lines.map(toLinePayload),
      });
      toast.success("Manual statement created", {
        description: `${statement.total_rows} line${statement.total_rows === 1 ? "" : "s"}, ${statement.matched_rows} matched. Review it, then calculate royalties.`,
      });
      router.push(`/royalties/statements/${statement.id}`);
    } catch (error) {
      if (isApiError(error) && (error.code === "plan_limit_exceeded" || error.status === 402)) {
        setGeneral([error.message]);
        return;
      }
      const mapped = mapManualApiErrors(error);
      setServerRows(mapped.rows);
      setServerMeta(mapped.fields as MetaErrors);
      setGeneral(mapped.general.length > 0 || Object.keys(mapped.rows).length > 0 ? mapped.general : [isApiError(error) ? error.message : "Something went wrong."]);
    }
  };

  const categoryOptions = [...(categories.data ?? [])]
    .sort((a, b) => (PREFERRED.indexOf(a.code) === -1 ? 99 : PREFERRED.indexOf(a.code)) - (PREFERRED.indexOf(b.code) === -1 ? 99 : PREFERRED.indexOf(b.code)))
    .map((c) => ({ value: c.code, label: c.name }));
  const pickingIndex = lines.findIndex((line) => line.key === picking);
  const serverRowCount = Object.keys(serverRows).length;

  return (
    <form onSubmit={submit} noValidate>
      <PageHeader
        title="Manual statement"
        description="Record licensing income or manual adjustments without a file. Lines linked to a recording or work are matched directly; others are matched automatically by ISRC, ISWC or title."
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: "Manual" }]}
        actions={
          <>
            <ButtonLink href="/royalties/statements" variant="outline">
              Cancel
            </ButtonLink>
            <Button type="submit" loading={create.isPending} leftIcon={<Save aria-hidden />}>
              Create statement
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Statement details" description="Created as processed, ready to review and calculate." />
          <CardBody className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <FormField label="Source name" required error={metaErrors.source_name} className="sm:col-span-2">
              <Input value={meta.source_name} maxLength={120} onChange={(e) => setField("source_name", e.target.value)} placeholder="e.g. Netflix sync licence, Q1 corrections" />
            </FormField>
            <FormField label="Category" required error={metaErrors.source_category} hint="Manual adjustment by default; licensing for sync and other licence fees.">
              {(props) => (
                <Select {...props} value={meta.source_category} onValueChange={(v) => setField("source_category", v)} options={categoryOptions.length > 0 ? categoryOptions : [{ value: "manual_adjustment", label: "Manual adjustments" }, { value: "licensing", label: "Licensing revenue" }]} />
              )}
            </FormField>
            <FormField label="Default rights type" hint="Used for lines without their own rights type.">
              {(props) => (
                <Select
                  {...props}
                  value={meta.default_rights_type || "auto"}
                  onValueChange={(v) => setField("default_rights_type", v === "auto" ? "" : v)}
                  options={[{ value: "auto", label: "Category default" }, ...(rightsTypes.data ?? []).map((r) => ({ value: r.code, label: r.name }))]}
                />
              )}
            </FormField>
            <FormField label="Period start" required error={metaErrors.period_start}>
              <Input type="date" value={meta.period_start} onChange={(e) => setField("period_start", e.target.value)} />
            </FormField>
            <FormField label="Period end" required error={metaErrors.period_end}>
              <Input type="date" value={meta.period_end} min={meta.period_start || undefined} onChange={(e) => setField("period_end", e.target.value)} />
            </FormField>
            <FormField label="Currency" required error={metaErrors.currency} hint="All lines use this currency.">
              {(props) => <Select {...props} value={meta.currency} onValueChange={(v) => setField("currency", v)} options={currencies.map((c) => ({ value: c, label: c }))} />}
            </FormField>
            <FormField label="Reported total" error={metaErrors.reported_total} hint="Optional control total to reconcile against.">
              <Input inputMode="decimal" value={meta.reported_total} onChange={(e) => setField("reported_total", e.target.value)} placeholder="Optional" />
            </FormField>
            <FormField label="Notes" error={metaErrors.notes} className="sm:col-span-2 xl:col-span-4">
              <Textarea rows={2} maxLength={5000} value={meta.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Optional internal notes" />
            </FormField>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Lines"
            description="Amounts are exact decimals; use a minus sign for refunds or corrections."
            actions={
              <Button type="button" variant="outline" size="sm" leftIcon={<Plus aria-hidden />} onClick={() => setLines((current) => [...current, emptyLine()])} disabled={lines.length >= MAX_MANUAL_LINES}>
                Add line
              </Button>
            }
          />
          <ScrollRegion>
            <table className="w-full min-w-[76rem] text-[13px]">
              <caption className="sr-only">Manual statement lines</caption>
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                  <th scope="col" className="w-10 px-3 py-2 font-medium">
                    #
                  </th>
                  <th scope="col" className="w-60 px-2 py-2 font-medium">
                    Catalog item · title
                  </th>
                  <th scope="col" className="w-40 px-2 py-2 font-medium">
                    ISRC · ISWC
                  </th>
                  <th scope="col" className="w-44 px-2 py-2 font-medium">
                    Territory · rights
                  </th>
                  <th scope="col" className="w-36 px-2 py-2 text-right font-medium">
                    Amount ({meta.currency})
                  </th>
                  <th scope="col" className="w-40 px-2 py-2 font-medium">
                    Date · usage
                  </th>
                  <th scope="col" className="min-w-52 px-2 py-2 font-medium">
                    Description
                  </th>
                  <th scope="col" className="w-20 px-3 py-2">
                    <span className="sr-only">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const errors = rowErrors(index);
                  const n = index + 1;
                  const id = (field: string) => `line-${line.key}-${field}`;
                  const describe = (field: keyof ManualLineErrors) => (errors[field] ? `${id(field)}-error` : undefined);
                  const err = (field: keyof ManualLineErrors) =>
                    errors[field] ? (
                      <p id={`${id(field)}-error`} role="alert" className="mt-1 text-xs font-medium text-danger">
                        {errors[field]}
                      </p>
                    ) : null;
                  const unidentified = validation.unidentified.includes(index);
                  return (
                    <tr key={line.key} className={cn("border-b border-border align-top last:border-0", (errors.row || Object.keys(errors).length > 0) && "bg-danger-soft/20")}>
                      <td className="px-3 py-3 tabular-nums text-fg-muted">{n}</td>
                      <td className="space-y-1.5 px-2 py-2">
                        {line.target ? (
                          <div className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary-soft/40 px-2 py-1">
                            <span className="min-w-0 flex-1 truncate text-xs text-primary-soft-fg" title={line.target.title}>
                              {line.target.kind === "recording" ? "Recording" : "Work"}: {line.target.title}
                            </span>
                            <IconButton label={`Clear catalog item on line ${n}`} icon={<X aria-hidden />} size="sm" onClick={() => updateLine(index, { target: null })} />
                          </div>
                        ) : (
                          <Button type="button" variant="outline" size="xs" leftIcon={<Link2 aria-hidden />} onClick={() => setPicking(line.key)} aria-label={`Pick recording or work for line ${n}`}>
                            Pick recording / work
                          </Button>
                        )}
                        <Input
                          className="h-8 text-[13px]"
                          aria-label={`Title, line ${n}`}
                          placeholder="Title"
                          maxLength={255}
                          value={line.title}
                          aria-invalid={errors.title ? true : undefined}
                          aria-describedby={describe("title")}
                          onChange={(e) => updateLine(index, { title: e.target.value })}
                        />
                        {err("title")}
                        {err("target")}
                        {err("row")}
                        {unidentified && !errors.row ? <p className="text-xs text-fg-subtle">No identifier — the line will stay unmatched and its income held.</p> : null}
                      </td>
                      <td className="space-y-1.5 px-2 py-2">
                        <Input
                          className="h-8 font-mono text-xs"
                          aria-label={`ISRC, line ${n}`}
                          placeholder="ISRC"
                          maxLength={20}
                          value={line.isrc}
                          aria-invalid={errors.isrc ? true : undefined}
                          aria-describedby={describe("isrc")}
                          onChange={(e) => updateLine(index, { isrc: e.target.value.toUpperCase() })}
                        />
                        {err("isrc")}
                        <Input
                          className="h-8 font-mono text-xs"
                          aria-label={`ISWC, line ${n}`}
                          placeholder="ISWC"
                          maxLength={20}
                          value={line.iswc}
                          aria-invalid={errors.iswc ? true : undefined}
                          aria-describedby={describe("iswc")}
                          onChange={(e) => updateLine(index, { iswc: e.target.value.toUpperCase() })}
                        />
                        {err("iswc")}
                      </td>
                      <td className="space-y-1.5 px-2 py-2">
                        <NativeSelect
                          className="h-8 text-[13px]"
                          aria-label={`Territory, line ${n}`}
                          value={line.territory}
                          aria-invalid={errors.territory ? true : undefined}
                          aria-describedby={describe("territory")}
                          onChange={(e) => updateLine(index, { territory: e.target.value })}
                        >
                          <option value="">No territory</option>
                          {(territories.data ?? []).map((t) => (
                            <option key={t.code} value={t.code}>
                              {t.code === "WORLD" ? "World" : `${t.code} · ${t.name}`}
                            </option>
                          ))}
                        </NativeSelect>
                        {err("territory")}
                        <NativeSelect className="h-8 text-[13px]" aria-label={`Rights type, line ${n}`} value={line.rights_type} onChange={(e) => updateLine(index, { rights_type: e.target.value })}>
                          <option value="">Default rights type</option>
                          {(rightsTypes.data ?? []).map((r) => (
                            <option key={r.code} value={r.code}>
                              {r.name}
                            </option>
                          ))}
                        </NativeSelect>
                        {err("rights_type")}
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          className="h-8 text-right tabular-nums"
                          inputMode="decimal"
                          aria-label={`Amount, line ${n}`}
                          aria-required
                          placeholder="0.00"
                          value={line.amount}
                          aria-invalid={errors.amount ? true : undefined}
                          aria-describedby={describe("amount")}
                          onChange={(e) => updateLine(index, { amount: e.target.value })}
                        />
                        {err("amount")}
                      </td>
                      <td className="space-y-1.5 px-2 py-2">
                        <Input
                          type="date"
                          className="h-8 text-[13px]"
                          aria-label={`Transaction date, line ${n}`}
                          value={line.transaction_date}
                          aria-invalid={errors.transaction_date ? true : undefined}
                          aria-describedby={describe("transaction_date")}
                          onChange={(e) => updateLine(index, { transaction_date: e.target.value })}
                        />
                        {err("transaction_date")}
                        <Input
                          className="h-8 text-[13px]"
                          aria-label={`Usage type, line ${n}`}
                          placeholder="Usage (e.g. sync)"
                          maxLength={60}
                          value={line.usage_type}
                          aria-invalid={errors.usage_type ? true : undefined}
                          aria-describedby={describe("usage_type")}
                          onChange={(e) => updateLine(index, { usage_type: e.target.value })}
                        />
                        {err("usage_type")}
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          className="h-8 text-[13px]"
                          aria-label={`Description, line ${n}`}
                          placeholder="Description"
                          maxLength={255}
                          value={line.description}
                          aria-invalid={errors.description ? true : undefined}
                          aria-describedby={describe("description")}
                          onChange={(e) => updateLine(index, { description: e.target.value })}
                        />
                        {err("description")}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <IconButton label={`Duplicate line ${n}`} icon={<Copy aria-hidden />} size="sm" onClick={() => duplicateLine(index)} disabled={lines.length >= MAX_MANUAL_LINES} />
                          <IconButton label={`Remove line ${n}`} icon={<Trash2 aria-hidden />} size="sm" onClick={() => removeLine(index)} disabled={lines.length === 1} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-strong bg-surface-2/60">
                  <th scope="row" colSpan={4} className="px-3 py-3 text-left font-semibold text-fg">
                    Total · {totals.counted.toLocaleString()} of {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
                    {totals.skipped > 0 ? <span className="ml-2 text-xs font-normal text-warning">{totals.skipped} without a valid amount not counted</span> : null}
                  </th>
                  <td className="px-2 py-3 text-right" aria-live="polite">
                    <Money amount={totals.total} currency={meta.currency} precision="exact" toneNegative className="text-[15px] font-semibold" />
                  </td>
                  <td colSpan={3} className="px-2 py-3 text-xs text-fg-subtle">
                    {totalMatchesReported ? (
                      <>
                        Reported total <Money amount={totalMatchesReported} currency={meta.currency} precision="exact" /> —{" "}
                        {totals.skipped === 0 && compareDecimals(totals.total, totalMatchesReported) === 0 ? (
                          <span className="font-medium text-success">matches</span>
                        ) : (
                          <span className="font-medium text-warning">differs</span>
                        )}
                      </>
                    ) : (
                      "Exact decimal sum (no rounding)."
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </ScrollRegion>
        </Card>

        {submitted && (validation.errors.length > 0 || general.length > 0 || serverRowCount > 0) ? (
          <Alert tone="danger" title="The statement was not created">
            <ul className="list-disc pl-4">
              {[...validation.errors, ...general].map((message) => (
                <li key={message}>{message}</li>
              ))}
              {serverRowCount > 0 ? <li>{serverRowCount} line(s) were rejected — see the highlighted rows.</li> : null}
              {general.some((m) => /limit/i.test(m)) ? (
                <li>
                  <Link href="/settings/billing" className="font-medium underline">
                    Review your plan
                  </Link>
                </li>
              ) : null}
            </ul>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" leftIcon={<Plus aria-hidden />} onClick={() => setLines((current) => [...current, emptyLine()])} disabled={lines.length >= MAX_MANUAL_LINES}>
            Add line
          </Button>
          <Button type="submit" loading={create.isPending} leftIcon={<Save aria-hidden />}>
            Create statement
          </Button>
        </div>
      </div>

      <PickerDialog
        orgId={org.id}
        open={pickingIndex !== -1}
        initialQuery={pickingIndex !== -1 ? lines[pickingIndex].isrc || lines[pickingIndex].title : ""}
        onClose={() => setPicking(null)}
        onPick={(selection) => {
          if (pickingIndex === -1) return;
          const line = lines[pickingIndex];
          updateLine(pickingIndex, {
            target: { kind: selection.kind, id: selection.id, title: selection.title },
            title: line.title || selection.title,
            isrc: line.isrc || (selection.kind === "recording" && selection.code ? selection.code : ""),
            iswc: line.iswc || (selection.kind === "work" && selection.code ? selection.code : ""),
          });
          setPicking(null);
        }}
      />
    </form>
  );
}

function PickerDialog({ orgId, open, initialQuery, onClose, onPick }: { orgId: string; open: boolean; initialQuery: string; onClose: () => void; onPick: (selection: CatalogSelection) => void }) {
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          setSelected(null);
          onClose();
        }
      }}
      size="lg"
      title="Link line to the catalog"
      description="The line is matched directly to this recording or work instead of being matched automatically."
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selected}
            leftIcon={<Link2 aria-hidden />}
            onClick={() => {
              if (selected) onPick(selected);
              setSelected(null);
            }}
          >
            Use this item
          </Button>
        </>
      }
    >
      <CatalogSearch orgId={orgId} initialQuery={initialQuery} value={selected} onChange={setSelected} />
    </Dialog>
  );
}
