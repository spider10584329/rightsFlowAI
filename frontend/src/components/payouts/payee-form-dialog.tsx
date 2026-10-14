"use client";

import { Lock, Search } from "lucide-react";
import { useState } from "react";

import { PAYMENT_METHOD_OPTIONS } from "@/components/payouts/workflow";
import { normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { useCreatePayee, usePartySearch, useUpdatePayee, type Payee, type PaymentMethod, type PaymentReference } from "@/lib/api/hooks/payouts";
import { cn } from "@/lib/utils";

interface FormState {
  party_id: string;
  party_name: string;
  display_name: string;
  email: string;
  payment_method: PaymentMethod;
  bank_name: string;
  account_last4: string;
  paypal_email: string;
  reference: string;
  country: string;
  currency: string;
  minimum_payout: string;
  hold_payments: boolean;
  notes: string;
}

type Errors = Partial<Record<keyof FormState | "form", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePayeeForm(form: FormState, creating: boolean): Errors {
  const errors: Errors = {};
  if (creating && !form.party_id) errors.party_id = "Choose the party this payee represents";
  if (form.display_name.length > 255) errors.display_name = "Use at most 255 characters";
  if (form.email && !EMAIL.test(form.email)) errors.email = "Enter a valid email address";
  if (form.account_last4 && !/^\d{4}$/.test(form.account_last4)) errors.account_last4 = "Enter exactly the last 4 digits — never the full number";
  if (form.paypal_email && !EMAIL.test(form.paypal_email)) errors.paypal_email = "Enter a valid PayPal email";
  if (form.country && !/^[A-Za-z]{2}$/.test(form.country)) errors.country = "Use a 2-letter country code";
  const min = validateAmount(form.minimum_payout, { allowZero: true, maxDecimals: 2 });
  if (min) errors.minimum_payout = min;
  if (form.notes.length > 5000) errors.notes = "Use at most 5,000 characters";
  return errors;
}

function initialState(payee: Payee | null, defaultCurrency: string): FormState {
  const ref = (payee?.payment_reference ?? {}) as Record<string, string>;
  return {
    party_id: payee?.party_id ?? "",
    party_name: payee?.party_name ?? "",
    display_name: payee?.display_name ?? "",
    email: payee?.email ?? "",
    payment_method: (payee?.payment_method as PaymentMethod) ?? "bank_transfer",
    bank_name: ref.bank_name ?? "",
    account_last4: ref.account_last4 ?? "",
    paypal_email: ref.paypal_email ?? "",
    reference: ref.reference ?? "",
    country: ref.country ?? "",
    currency: payee?.currency ?? defaultCurrency ?? "USD",
    minimum_payout: payee?.minimum_payout ?? "0",
    hold_payments: payee?.hold_payments ?? false,
    notes: payee?.notes ?? "",
  };
}

export function PayeeFormDialog({
  orgId,
  open,
  onOpenChange,
  payee,
  defaultCurrency,
  onSaved,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payee?: Payee | null;
  defaultCurrency: string;
  onSaved?: (payee: Payee) => void;
}) {
  if (!open) return null;
  return <PayeeFormInner orgId={orgId} onOpenChange={onOpenChange} payee={payee ?? null} defaultCurrency={defaultCurrency} onSaved={onSaved} />;
}

function PayeeFormInner({
  orgId,
  onOpenChange,
  payee,
  defaultCurrency,
  onSaved,
}: {
  orgId: string;
  onOpenChange: (open: boolean) => void;
  payee: Payee | null;
  defaultCurrency: string;
  onSaved?: (payee: Payee) => void;
}) {
  const creating = !payee;
  const [form, setForm] = useState<FormState>(() => initialState(payee, defaultCurrency));
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);
  const [partyQuery, setPartyQuery] = useState("");
  const parties = usePartySearch(orgId, partyQuery, creating);
  const currencies = useCurrencyCodes();
  const create = useCreatePayee(orgId);
  const update = useUpdatePayee(orgId, payee?.id ?? "");
  const pending = create.isPending || update.isPending;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (submitted) setErrors(validatePayeeForm(next, creating));
  };

  const save = async () => {
    setSubmitted(true);
    const found = validatePayeeForm(form, creating);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const reference: PaymentReference = {};
    if (form.bank_name.trim()) reference.bank_name = form.bank_name.trim();
    if (form.account_last4) reference.account_last4 = form.account_last4;
    if (form.paypal_email.trim()) reference.paypal_email = form.paypal_email.trim();
    if (form.reference.trim()) reference.reference = form.reference.trim();
    if (form.country) reference.country = form.country.toUpperCase();
    const body = {
      display_name: form.display_name.trim() || null,
      email: form.email.trim() || null,
      payment_method: form.payment_method,
      payment_reference: Object.keys(reference).length > 0 ? reference : null,
      currency: form.currency,
      minimum_payout: normalizeAmountInput(form.minimum_payout),
      hold_payments: form.hold_payments,
      notes: form.notes.trim() || null,
    };
    try {
      const saved = creating ? await create.mutateAsync({ party_id: form.party_id, ...body }) : await update.mutateAsync(body);
      toast.success(creating ? "Payee created" : "Payee updated");
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.isValidation) {
        const mapped = fieldErrors(error);
        setErrors({ ...mapped, form: Object.keys(mapped).length === 0 ? errorMessage(error) : undefined });
      } else {
        setErrors({ form: errorMessage(error) });
      }
    }
  };

  const showBank = form.payment_method === "bank_transfer" || form.payment_method === "wire";

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onOpenChange(false)}
      size="lg"
      title={creating ? "New payee" : `Edit ${payee?.display_name}`}
      description="Payees receive royalties posted to the ledger. Profiles are also created automatically when a run is posted."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={pending}>
            {creating ? "Create payee" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {creating ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label required>Party</Label>
            <Input
              value={partyQuery}
              onChange={(e) => setPartyQuery(e.target.value)}
              placeholder="Search artists, writers, labels…"
              leadingIcon={<Search aria-hidden />}
              aria-label="Search parties"
            />
            <div role="radiogroup" aria-label="Parties" aria-invalid={errors.party_id ? true : undefined} className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {parties.isLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : (parties.data?.items ?? []).length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-fg-muted">No parties found. Add the party in Catalog → Artists & contributors first.</p>
              ) : (
                (parties.data?.items ?? []).map((party) => (
                  <button
                    key={party.id}
                    type="button"
                    role="radio"
                    aria-checked={form.party_id === party.id}
                    onClick={() => {
                      setForm((current) => ({ ...current, party_id: party.id, party_name: party.name, display_name: current.display_name || party.name, email: current.email || party.email || "" }));
                      if (submitted) setErrors((current) => ({ ...current, party_id: undefined }));
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-ring",
                      form.party_id === party.id ? "bg-primary-soft text-primary-soft-fg" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="truncate">{party.name}</span>
                    <span className="text-xs text-fg-subtle">{party.is_internal ? "Internal" : party.party_type}</span>
                  </button>
                ))
              )}
            </div>
            {form.party_id ? <p className="text-xs text-fg-muted">Selected: {form.party_name}</p> : null}
            {errors.party_id ? (
              <p role="alert" className="text-xs font-medium text-danger">
                {errors.party_id}
              </p>
            ) : null}
          </div>
        ) : null}
        <FormField label="Display name" error={errors.display_name} hint="Defaults to the party name.">
          <Input value={form.display_name} maxLength={255} onChange={(e) => set("display_name", e.target.value)} />
        </FormField>
        <FormField label="Email" error={errors.email}>
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </FormField>
        <FormField label="Payment method">
          {(props) => <Select {...props} value={form.payment_method} onValueChange={(v) => set("payment_method", v as PaymentMethod)} options={PAYMENT_METHOD_OPTIONS} />}
        </FormField>
        <FormField label="Payout currency">
          {(props) => <Select {...props} value={form.currency} onValueChange={(v) => set("currency", v)} options={currencies.map((c) => ({ value: c, label: c }))} />}
        </FormField>

        <div className="space-y-3 rounded-lg border border-border bg-surface-2/40 p-4 sm:col-span-2">
          <p className="flex items-start gap-2 text-xs text-fg-muted">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Only non-sensitive references are stored. RightsFlow never stores full bank account or card numbers — keep those in your bank or payment provider.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {showBank ? (
              <>
                <FormField label="Bank name" error={errors.bank_name}>
                  <Input value={form.bank_name} maxLength={120} onChange={(e) => set("bank_name", e.target.value)} />
                </FormField>
                <FormField label="Account (last 4 digits)" error={errors.account_last4} hint="For identification on remittances only.">
                  <Input inputMode="numeric" maxLength={4} value={form.account_last4} onChange={(e) => set("account_last4", e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="1234" />
                </FormField>
              </>
            ) : null}
            {form.payment_method === "paypal" ? (
              <FormField label="PayPal email" error={errors.paypal_email}>
                <Input type="email" value={form.paypal_email} onChange={(e) => set("paypal_email", e.target.value)} />
              </FormField>
            ) : null}
            <FormField label="Reference" error={errors.reference} hint="e.g. vendor number or remittance reference">
              <Input value={form.reference} maxLength={120} onChange={(e) => set("reference", e.target.value)} />
            </FormField>
            <FormField label="Country" error={errors.country} hint="2-letter code">
              <Input value={form.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} placeholder="US" />
            </FormField>
          </div>
        </div>

        <FormField label="Minimum payout" error={errors.minimum_payout} hint={`Balances below this (in ${form.currency}) are skipped when drafting batches.`}>
          <Input inputMode="decimal" value={form.minimum_payout} onChange={(e) => set("minimum_payout", e.target.value)} />
        </FormField>
        <div className="flex items-start gap-3 pt-6">
          <Switch id="hold-payments" checked={form.hold_payments} onCheckedChange={(v) => set("hold_payments", v)} />
          <div>
            <Label htmlFor="hold-payments">Hold payments</Label>
            <p className="text-xs text-fg-subtle">Earnings still accrue, but the payee is skipped in new batches.</p>
          </div>
        </div>
        <FormField label="Notes" error={errors.notes} className="sm:col-span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </FormField>
        {errors.form ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg sm:col-span-2">
            {errors.form}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
