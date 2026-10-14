"use client";

import { BadgeCheck, Ban, Download, FileText, Pencil, Send, Trash2, Wallet } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { ProviderNotice } from "@/components/payouts/provider-notice";
import { batchPermissions, batchStatus, batchWorkflow, paymentMethodLabel } from "@/components/payouts/workflow";
import { normalizeAmountInput, validateAmount } from "@/components/royalties/money";
import { Money, Stepper } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { useSession } from "@/components/session/session-provider";
import { DetailLoadError } from "@/components/shared/detail-load-error";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useOrganizationDetail } from "@/lib/api/hooks/organizations";
import {
  downloadPayoutAdvice,
  downloadRemittance,
  useAmendPayout,
  useBatch,
  useBatchAction,
  useRemovePayout,
  type Payout,
  type PayoutBatch,
} from "@/lib/api/hooks/payouts";
import { formatDateTime } from "@/lib/utils";

import { MarkPaidDialog } from "./mark-paid-dialog";

type DialogKind = "submit" | "approve" | "cancel" | "paid" | null;

function describeBatchError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "distinct_approver_required") return "A different admin must approve this batch: the person who created a batch can't approve it while “Require a distinct payout approver” is on in organization settings.";
    if (error.code === "insufficient_balance") return "Some payees no longer have enough available balance (for example after a reversal). Cancel this batch and draft a new one.";
  }
  return errorMessage(error);
}

export function BatchDetailClient() {
  const { id } = useParams<{ id: string }>();
  const { org } = useOrg();
  const { user } = useSession();
  const batch = useBatch(org.id, id);
  const detail = useOrganizationDetail(org.id);
  const submit = useBatchAction(org.id, id, "submit");
  const approve = useBatchAction(org.id, id, "approve");
  const cancel = useBatchAction(org.id, id, "cancel");
  const remove = useRemovePayout(org.id, id);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editing, setEditing] = useState<Payout | null>(null);
  const [removing, setRemoving] = useState<Payout | null>(null);

  if (batch.isLoading) return <PageSkeleton />;
  if (batch.error || !batch.data) {
    return (
      <DetailLoadError
        error={batch.error}
        noun="Payout batch"
        breadcrumbs={[{ label: "Payouts", href: "/payouts" }]}
        backHref="/payouts"
        backLabel="Back to payouts"
        onRetry={() => void batch.refetch()}
      />
    );
  }
  const b = batch.data;
  const perms = batchPermissions(b.status, org.role);
  const workflow = batchWorkflow(b);
  const status = batchStatus(b.status);
  const distinctRequired = detail.data?.settings.require_distinct_payout_approver ?? true;
  const selfApprovalBlocked = distinctRequired && b.created_by_id === user.id;
  const activePayouts = b.payouts.filter((p) => p.status !== "cancelled");

  const download = (fn: () => Promise<void>) => void fn().catch((error) => toast.error("Download failed", { description: errorMessage(error) }));

  const columns: DataTableColumn<Payout>[] = [
    {
      id: "payee",
      header: "Payee",
      cell: (p) => (
        <Link href={`/payouts/payees/${p.payee_id}`} className="font-medium text-fg hover:text-primary">
          {p.payee_name ?? "Payee"}
        </Link>
      ),
    },
    { id: "method", header: "Method", hideOnMobile: true, cell: (p) => <span className="text-xs text-fg-muted">{paymentMethodLabel(p.payment_method)}</span> },
    {
      id: "status",
      header: "Status",
      cell: (p) => (
        <Badge tone={p.status === "paid" ? "success" : p.status === "cancelled" ? "danger" : "info"} dot>
          {p.status === "paid" ? "Recorded paid" : p.status === "cancelled" ? "Cancelled" : "Pending"}
        </Badge>
      ),
    },
    { id: "reference", header: "External reference", hideOnMobile: true, cell: (p) => <span className="font-mono text-xs text-fg-muted">{p.external_reference ?? "—"}</span> },
    { id: "amount", header: "Amount", align: "right", cell: (p) => <Money amount={p.amount} currency={p.currency} className="font-semibold" /> },
  ];

  const actionsFor = (p: Payout): RowAction[] => {
    const actions: RowAction[] = [{ label: "Download advice (CSV)", icon: <FileText aria-hidden />, onSelect: () => download(() => downloadPayoutAdvice(org.id, b.id, p.id)) }];
    if (perms.canEdit) {
      actions.push({ label: "Edit amount", icon: <Pencil aria-hidden />, onSelect: () => setEditing(p) });
      actions.push({ label: "Remove from batch", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setRemoving(p) });
    }
    return actions;
  };

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{b.reference}</span>}
        meta={
          <Badge tone={status.tone} dot size="md">
            {status.label}
          </Badge>
        }
        description={b.notes ?? `${b.currency} payout batch created ${formatDateTime(b.created_at)}`}
        breadcrumbs={[{ label: "Payouts", href: "/payouts" }, { label: b.reference }]}
        actions={
          <>
            <Button variant="outline" leftIcon={<Download aria-hidden />} onClick={() => download(() => downloadRemittance(org.id, b.id))}>
              Remittance CSV
            </Button>
            {perms.canCancel ? (
              <Button variant="ghost" leftIcon={<Ban aria-hidden />} onClick={() => setDialog("cancel")}>
                Cancel batch
              </Button>
            ) : null}
            {perms.canSubmit ? (
              <Button leftIcon={<Send aria-hidden />} onClick={() => setDialog("submit")} disabled={b.payout_count === 0}>
                Submit for approval
              </Button>
            ) : null}
            {perms.canApprove ? (
              <Button leftIcon={<BadgeCheck aria-hidden />} onClick={() => setDialog("approve")}>
                Approve
              </Button>
            ) : null}
            {perms.canMarkPaid ? (
              <Button leftIcon={<Wallet aria-hidden />} onClick={() => setDialog("paid")}>
                Record as paid
              </Button>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <CardBody className="py-4">
            <Stepper
              label="Payout workflow"
              steps={workflow.steps.map((step) => ({ key: step.key, label: step.label, state: step.state, description: step.at ? formatDateTime(step.at) : undefined }))}
            />
          </CardBody>
        </Card>
        <NextStepAlert batch={b} perms={perms} selfApprovalBlocked={selfApprovalBlocked} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total" value={<Money amount={b.total_amount} currency={b.currency} />} hint={`${b.currency} · whole cents`} />
          <StatCard label="Payouts" value={b.payout_count.toLocaleString()} hint={activePayouts.length !== b.payouts.length ? `${b.payouts.length - activePayouts.length} cancelled` : undefined} />
          <StatCard label="Approved" value={b.approved_at ? formatDateTime(b.approved_at) : "—"} />
          <StatCard label="Recorded as paid" value={b.paid_at ? formatDateTime(b.paid_at) : "—"} />
        </div>
        <Card>
          <CardHeader title="Payouts" description={perms.canEdit ? "Adjust amounts or remove payees while the batch is a draft. Amounts can't exceed the payee's available balance." : "Amounts are locked once the batch leaves draft."} />
          <div className="overflow-x-auto">
            <DataTable
              columns={columns}
              data={b.payouts}
              getRowId={(p) => p.id}
              getRowLabel={(p) => p.payee_name ?? "payout"}
              rowActions={actionsFor}
              caption="Payouts in this batch"
              emptyState={<EmptyState compact icon={<Wallet aria-hidden />} title="No payouts" description="Every payout was removed. Cancel this batch or draft a new one." />}
            />
          </div>
        </Card>
        <ProviderNotice orgId={org.id} />
      </div>

      <ConfirmDialog
        open={dialog === "submit"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Submit for approval?"
        description="Amounts are locked and an admin is asked to approve the batch."
        confirmLabel="Submit"
        tone="primary"
        onConfirm={async () => {
          await submit.mutateAsync(undefined);
          toast.success("Submitted for approval");
        }}
      />
      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Approve this batch?"
        description="Balances are re-checked. After approval an admin pays the recipients outside RightsFlow and records the batch as paid."
        confirmLabel="Approve"
        tone="primary"
        onConfirm={async () => {
          try {
            await approve.mutateAsync(undefined);
          } catch (error) {
            throw new Error(describeBatchError(error));
          }
          toast.success("Batch approved");
        }}
      >
        {selfApprovalBlocked ? (
          <Alert tone="warning" title="Distinct approver required">
            You created this batch. While “Require a distinct payout approver” is on, another admin must approve it.
          </Alert>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "cancel"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Cancel this batch?"
        description="Pending payouts are cancelled and their amounts become available again. Nothing is written to the ledger."
        confirmLabel="Cancel batch"
        cancelLabel="Keep batch"
        onConfirm={async () => {
          await cancel.mutateAsync(undefined);
          toast.success("Batch cancelled");
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove payout?"
        description={removing ? `${removing.payee_name ?? "This payee"} will be removed from the draft. Their balance stays available for a later batch.` : undefined}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          toast.success("Payout removed");
        }}
      />
      <EditAmountDialog orgId={org.id} batch={b} payout={editing} onClose={() => setEditing(null)} />
      <MarkPaidDialog orgId={org.id} batch={b} open={dialog === "paid"} onClose={() => setDialog(null)} />
    </>
  );
}

function NextStepAlert({ batch, perms, selfApprovalBlocked }: { batch: PayoutBatch; perms: ReturnType<typeof batchPermissions>; selfApprovalBlocked: boolean }) {
  switch (batch.status) {
    case "draft":
      return (
        <Alert tone="info" title="Draft">
          {perms.canSubmit ? "Review the amounts, then submit the batch for approval." : "A manager will review and submit this batch."}
        </Alert>
      );
    case "pending_approval":
      return (
        <Alert tone={selfApprovalBlocked && perms.canApprove ? "warning" : "info"} title="Waiting for approval">
          {perms.canApprove
            ? selfApprovalBlocked
              ? "You created this batch, so another admin must approve it (distinct approver required)."
              : "Check the payees and amounts, then approve."
            : "An admin must approve this batch."}
        </Alert>
      );
    case "approved":
      return (
        <Alert tone="warning" title="Approved — pay outside RightsFlow">
          Execute the payments through your bank or payment provider, then {perms.canMarkPaid ? "record the batch as paid" : "ask an admin to record the batch as paid"}. Only then are payout entries written to the ledger.
        </Alert>
      );
    case "paid":
      return (
        <Alert tone="success" title={`Recorded as paid ${formatDateTime(batch.paid_at)}`}>
          Negative payout entries were written to each payee&apos;s ledger. This records a payment made outside RightsFlow; it is not a bank confirmation.
        </Alert>
      );
    case "cancelled":
      return (
        <Alert tone="danger" title={`Cancelled ${formatDateTime(batch.cancelled_at)}`}>
          No ledger entries were written. Draft a new batch to pay these balances.
        </Alert>
      );
    default:
      return null;
  }
}

function EditAmountDialog({ orgId, batch, payout, onClose }: { orgId: string; batch: PayoutBatch; payout: Payout | null; onClose: () => void }) {
  const amend = useAmendPayout(orgId, batch.id);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [payoutId, setPayoutId] = useState<string | null>(null);
  if ((payout?.id ?? null) !== payoutId) {
    setPayoutId(payout?.id ?? null);
    setAmount(payout?.amount ?? "");
    setError(null);
  }
  const save = async () => {
    if (!payout) return;
    const problem = validateAmount(amount, { maxDecimals: 2 });
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await amend.mutateAsync({ payoutId: payout.id, amount: normalizeAmountInput(amount) });
      toast.success("Amount updated");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <Dialog
      open={payout !== null}
      onOpenChange={(open) => !open && !amend.isPending && onClose()}
      title="Edit payout amount"
      description={payout ? `${payout.payee_name ?? "Payee"} · ${batch.currency}. The amount can't exceed their available balance.` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={amend.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={amend.isPending}>
            Save amount
          </Button>
        </>
      }
    >
      <FormField label={`Amount (${batch.currency})`} required error={error ?? undefined} hint="Whole cents (2 decimal places).">
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
        />
      </FormField>
    </Dialog>
  );
}
