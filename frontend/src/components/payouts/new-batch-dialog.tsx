"use client";

import { useState } from "react";

import { Money } from "@/components/royalties/shared";
import { compareDecimals } from "@/components/royalties/money";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import { useCreateBatch, usePayees, type PayoutBatch } from "@/lib/api/hooks/payouts";

const SKIP_REASONS: Record<string, string> = {
  payments_on_hold: "payments on hold",
  below_minimum_payout: "below minimum payout",
};

export function NewBatchDialog({ orgId, open, onOpenChange, defaultCurrency, onCreated }: { orgId: string; open: boolean; onOpenChange: (open: boolean) => void; defaultCurrency: string; onCreated: (batch: PayoutBatch) => void }) {
  if (!open) return null;
  return <NewBatchForm orgId={orgId} onOpenChange={onOpenChange} defaultCurrency={defaultCurrency} onCreated={onCreated} />;
}

function NewBatchForm({ orgId, onOpenChange, defaultCurrency, onCreated }: { orgId: string; onOpenChange: (open: boolean) => void; defaultCurrency: string; onCreated: (batch: PayoutBatch) => void }) {
  const currencies = useCurrencyCodes();
  const create = useCreateBatch(orgId);
  const [currency, setCurrency] = useState(defaultCurrency);
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const payees = usePayees(orgId, { page: 1, page_size: 200, with_balance: true, active: true, sort: "display_name", order: "asc" });

  const eligible = (payees.data?.items ?? [])
    .map((p) => ({ payee: p, row: p.balances.find((b) => b.currency === currency) }))
    .filter((item) => item.row && compareDecimals(item.row.available, "0") > 0);

  const submit = async () => {
    setError(null);
    if (mode === "selected" && selected.size === 0) {
      setError("Select at least one payee, or include all eligible payees.");
      return;
    }
    try {
      const batch = await create.mutateAsync({ currency, payee_ids: mode === "selected" ? [...selected] : null, notes: notes.trim() || null });
      toast.success(`Draft ${batch.reference} created`, { description: `${batch.payout_count} payout${batch.payout_count === 1 ? "" : "s"}. Review amounts, then submit for approval.` });
      onCreated(batch);
      onOpenChange(false);
    } catch (cause) {
      if (isApiError(cause) && cause.isValidation && cause.details && typeof cause.details === "object" && "skipped" in (cause.details as object)) {
        const skipped = (cause.details as { skipped: { payee_id: string; reason: string }[] }).skipped;
        const names = new Map((payees.data?.items ?? []).map((p) => [p.id, p.display_name]));
        setError(
          `${cause.message}.${skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `${names.get(s.payee_id) ?? "payee"} (${SKIP_REASONS[s.reason] ?? s.reason})`).join(", ")}.` : ""}`,
        );
        return;
      }
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !create.isPending && onOpenChange(false)}
      size="lg"
      title="New payout batch"
      description="Drafts one payout per payee for their available balance, rounded down to whole cents. Payees on hold or below their minimum are skipped. Nothing is paid until the batch is approved and recorded as paid."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={create.isPending}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Currency" required hint="Each batch pays a single currency.">
            {(props) => (
              <Select
                {...props}
                value={currency}
                onValueChange={(v) => {
                  setCurrency(v);
                  setSelected(new Set());
                }}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            )}
          </FormField>
          <FormField label="Payees">
            {(props) => (
              <Select
                {...props}
                value={mode}
                onValueChange={(v) => setMode(v as "all" | "selected")}
                options={[
                  { value: "all", label: "All eligible payees" },
                  { value: "selected", label: "Selected payees only" },
                ]}
              />
            )}
          </FormField>
        </div>
        <div className="rounded-lg border border-border">
          <p className="border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">
            {eligible.length} payee{eligible.length === 1 ? "" : "s"} with an available {currency} balance
          </p>
          <ul className="max-h-56 divide-y divide-border overflow-y-auto">
            {payees.isLoading ? (
              <li className="p-3">
                <Skeleton className="h-6 w-full" />
              </li>
            ) : payees.error ? (
              <li className="p-3 text-[13px] text-danger">{errorMessage(payees.error)}</li>
            ) : eligible.length === 0 ? (
              <li className="p-3 text-center text-[13px] text-fg-muted">No payee has an available {currency} balance. Post a calculation run first.</li>
            ) : (
              eligible.map(({ payee, row }) => {
                const id = `batch-payee-${payee.id}`;
                return (
                  <li key={payee.id} className="flex items-center gap-3 px-3 py-2">
                    {mode === "selected" ? (
                      <Checkbox
                        id={id}
                        checked={selected.has(payee.id)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(payee.id);
                            else next.delete(payee.id);
                            return next;
                          })
                        }
                      />
                    ) : null}
                    <label htmlFor={mode === "selected" ? id : undefined} className="flex flex-1 items-center justify-between gap-3 text-[13px]">
                      <span className="truncate">
                        {payee.display_name}
                        {payee.hold_payments ? <span className="ml-2 text-xs text-warning">on hold — will be skipped</span> : null}
                      </span>
                      <Money amount={row?.available} currency={currency} className="font-medium" />
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>
        <FormField label="Notes">
          <Textarea rows={2} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional, e.g. Q1 2026 royalty run" />
        </FormField>
        {error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
