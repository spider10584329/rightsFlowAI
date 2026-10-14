"use client";

import { useState } from "react";

import { formatMoney, negateDecimal, normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { useContractSearch, useRecordAdjustment, useRecordAdvance, useReverseLedgerEntry, type LedgerEntry } from "@/lib/api/hooks/payouts";

type Kind = "adjustment" | "advance";

interface Errors {
  amount?: string;
  currency?: string;
  description?: string;
  effective_date?: string;
  form?: string;
}

/** Record a manual ± adjustment or a recoupable advance (admin). */
export function LedgerEntryDialog({ orgId, payeeId, payeeName, kind, defaultCurrency, onClose }: { orgId: string; payeeId: string; payeeName: string; kind: Kind | null; defaultCurrency: string; onClose: () => void }) {
  if (!kind) return null;
  return <LedgerEntryForm orgId={orgId} payeeId={payeeId} payeeName={payeeName} kind={kind} defaultCurrency={defaultCurrency} onClose={onClose} />;
}

function LedgerEntryForm({ orgId, payeeId, payeeName, kind, defaultCurrency, onClose }: { orgId: string; payeeId: string; payeeName: string; kind: Kind; defaultCurrency: string; onClose: () => void }) {
  const currencies = useCurrencyCodes();
  const adjustment = useRecordAdjustment(orgId);
  const advance = useRecordAdvance(orgId);
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [description, setDescription] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [contractQuery, setContractQuery] = useState("");
  const [contractId, setContractId] = useState<string>("none");
  const contracts = useContractSearch(orgId, contractQuery, kind === "advance");
  const [errors, setErrors] = useState<Errors>({});
  const pending = adjustment.isPending || advance.isPending;

  const validate = (): Errors => {
    const found: Errors = {};
    const amountError = validateAmount(amount, { maxDecimals: 8 });
    if (amountError) found.amount = amountError;
    if (description.trim().length < 3) found.description = "Describe the entry (at least 3 characters)";
    if (description.length > 500) found.description = "Use at most 500 characters";
    return found;
  };

  const normalized = normalizeAmountInput(amount).replace(/^[+-]/, "");
  const signed = kind === "adjustment" && direction === "debit" ? `-${normalized}` : normalized;

  const save = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      if (kind === "adjustment") {
        await adjustment.mutateAsync({ payee_id: payeeId, amount: signed, currency, description: description.trim(), effective_date: effectiveDate || null });
        toast.success("Adjustment recorded", { description: `${formatMoney(signed, currency, { signDisplay: "always", precision: "exact" })} for ${payeeName}` });
      } else {
        await advance.mutateAsync({
          payee_id: payeeId,
          amount: normalized,
          currency,
          description: description.trim(),
          contract_id: contractId === "none" ? null : contractId,
          effective_date: effectiveDate || null,
        });
        toast.success("Advance recorded", { description: `${formatMoney(normalized, currency, { precision: "exact" })} will be recouped from future earnings.` });
      }
      onClose();
    } catch (error) {
      if (isApiError(error) && error.isValidation) {
        const mapped = fieldErrors(error);
        setErrors({ ...mapped, form: Object.keys(mapped).length === 0 ? errorMessage(error) : undefined });
      } else setErrors({ form: errorMessage(error) });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={kind === "adjustment" ? "Record adjustment" : "Record recoupable advance"}
      description={
        kind === "adjustment"
          ? `A manual ledger entry for ${payeeName}. Credits increase the balance; debits reduce it. It can be reversed once if recorded in error.`
          : `Money already paid to ${payeeName} in advance. It's recorded as a negative entry and recouped automatically from future earnings in the same currency.`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={pending}>
            {kind === "adjustment" ? "Record adjustment" : "Record advance"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {kind === "adjustment" ? (
          <FormField label="Direction" className="sm:col-span-2">
            {(props) => (
              <Select
                {...props}
                value={direction}
                onValueChange={(v) => setDirection(v as "credit" | "debit")}
                options={[
                  { value: "credit", label: "Credit (+) — increases what the payee is owed" },
                  { value: "debit", label: "Debit (−) — reduces what the payee is owed" },
                ]}
              />
            )}
          </FormField>
        ) : null}
        <FormField label="Amount" required error={errors.amount} hint="Exact decimal, up to 8 decimal places.">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </FormField>
        <FormField label="Currency" required error={errors.currency}>
          {(props) => <Select {...props} value={currency} onValueChange={setCurrency} options={currencies.map((c) => ({ value: c, label: c }))} />}
        </FormField>
        <FormField label="Description" required error={errors.description} className="sm:col-span-2">
          <Textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={kind === "adjustment" ? "e.g. Correction for Q1 sync fee" : "e.g. Signing advance per recording agreement"} />
        </FormField>
        <FormField label="Effective date" error={errors.effective_date} hint="Defaults to today.">
          <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </FormField>
        {kind === "advance" ? (
          <div className="space-y-1.5">
            <FormField label="Linked contract" hint="Optional">
              {(props) => (
                <Select
                  {...props}
                  value={contractId}
                  onValueChange={setContractId}
                  options={[{ value: "none", label: "No contract" }, ...(contracts.data?.items ?? []).map((c) => ({ value: c.id, label: c.title, description: c.party_names.join(", ") || undefined }))]}
                />
              )}
            </FormField>
            <Input className="h-8 text-[13px]" placeholder="Filter contracts…" value={contractQuery} onChange={(e) => setContractQuery(e.target.value)} aria-label="Filter contracts" />
          </div>
        ) : null}
        {amount && !errors.amount && !validateAmount(amount, { maxDecimals: 8 }) ? (
          <p className="text-[13px] text-fg-muted sm:col-span-2">
            Ledger effect:{" "}
            <span className="font-semibold text-fg">
              {formatMoney(kind === "advance" ? `-${normalized}` : signed, currency, { signDisplay: "always", precision: "exact" })}
            </span>
          </p>
        ) : null}
        {errors.form ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg sm:col-span-2">
            {errors.form}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function ReverseEntryDialog({ orgId, entry, onClose }: { orgId: string; entry: LedgerEntry | null; onClose: () => void }) {
  const reverse = useReverseLedgerEntry(orgId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  if ((entry?.id ?? null) !== entryId) {
    setEntryId(entry?.id ?? null);
    setReason("");
    setError(null);
  }
  const submit = async () => {
    if (!entry) return;
    if (reason.trim().length < 3) {
      setError("Explain why this entry is reversed (at least 3 characters)");
      return;
    }
    try {
      await reverse.mutateAsync({ entryId: entry.id, reason: reason.trim() });
      toast.success("Entry reversed", { description: "An offsetting reversal entry was written." });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => !open && !reverse.isPending && onClose()}
      title="Reverse ledger entry"
      description={
        entry
          ? `Writes an offsetting entry of ${formatMoney(negateDecimal(entry.amount), entry.currency, { signDisplay: "always", precision: "exact" })}. The original stays in the ledger; each entry can be reversed once.`
          : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={reverse.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={reverse.isPending}>
            Reverse entry
          </Button>
        </>
      }
    >
      <FormField label="Reason" required error={error ?? undefined}>
        <Textarea
          value={reason}
          maxLength={2000}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
        />
      </FormField>
    </Dialog>
  );
}
