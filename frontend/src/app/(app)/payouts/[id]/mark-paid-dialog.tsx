"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { Money } from "@/components/royalties/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useMarkPaid, type PayoutBatch } from "@/lib/api/hooks/payouts";

function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function MarkPaidDialog({ orgId, batch, open, onClose }: { orgId: string; batch: PayoutBatch; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <MarkPaidForm orgId={orgId} batch={batch} onClose={onClose} />;
}

function MarkPaidForm({ orgId, batch, onClose }: { orgId: string; batch: PayoutBatch; onClose: () => void }) {
  const markPaid = useMarkPaid(orgId, batch.id);
  const [paymentDate, setPaymentDate] = useState(todayIso);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = batch.payouts.filter((p) => p.status === "pending");

  const submit = async () => {
    setError(null);
    if (!confirmed) {
      setError("Confirm that the payments were executed outside RightsFlow.");
      return;
    }
    if (paymentDate && paymentDate > todayIso()) {
      setError("The payment date can't be in the future.");
      return;
    }
    const refs = Object.fromEntries(Object.entries(references).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    try {
      await markPaid.mutateAsync({ payment_date: paymentDate || null, external_references: Object.keys(refs).length > 0 ? refs : null, notes: notes.trim() || null });
      toast.success("Batch recorded as paid", { description: "Payout entries were written to the payee ledgers." });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !markPaid.isPending && onClose()}
      size="lg"
      title="Record batch as paid"
      description="RightsFlow does not move money. Only record this batch once every payment below has actually been executed through your bank or payment provider."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={markPaid.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={markPaid.isPending} disabled={!confirmed}>
            Record as paid
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-soft-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Recording payment writes negative <span className="font-semibold">payout</span> entries to each payee&apos;s ledger, reducing their balance by{" "}
            <Money amount={batch.total_amount} currency={batch.currency} className="font-semibold" /> in total. This can&apos;t be undone from this screen.
          </p>
        </div>
        <FormField label="Payment date" hint="When the money left your account. Defaults to today.">
          <Input type="date" value={paymentDate} max={todayIso()} onChange={(e) => setPaymentDate(e.target.value)} />
        </FormField>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-fg">External references (optional)</legend>
          <p className="text-xs text-fg-subtle">Bank transfer IDs or check numbers, shown on remittance and advice files.</p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {pending.map((payout) => (
              <li key={payout.id} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_8rem_12rem]">
                <span className="truncate text-[13px] text-fg">{payout.payee_name}</span>
                <Money amount={payout.amount} currency={payout.currency} className="text-right text-[13px] font-medium" />
                <Input
                  className="h-8 text-[13px]"
                  aria-label={`External reference for ${payout.payee_name ?? "payout"}`}
                  maxLength={120}
                  value={references[payout.id] ?? ""}
                  onChange={(e) => setReferences((current) => ({ ...current, [payout.id]: e.target.value }))}
                  placeholder="e.g. TX-48213"
                />
              </li>
            ))}
          </ul>
        </fieldset>
        <FormField label="Notes">
          <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
          <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} className="mt-0.5" aria-describedby="paid-confirm-text" />
          <span id="paid-confirm-text">
            I confirm these payments were executed <span className="font-semibold">outside RightsFlow</span> for the amounts shown.
          </span>
        </label>
        {error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
