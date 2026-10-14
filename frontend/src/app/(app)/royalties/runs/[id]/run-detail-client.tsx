"use client";

import { BookCheck, Calculator, FileSpreadsheet, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { basisLabel } from "@/components/royalties/allocation-explanation";
import { RunStatusBadge, formatIsoDate } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { DetailLoadError } from "@/components/shared/detail-load-error";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useCalculateStatement, useDiscardRun, usePostRun, useReverseRun, useRun, useVerifyRun, type VerifyResult } from "@/lib/api/hooks/royalties";
import { formatDateTime } from "@/lib/utils";

import { AllocationsCard } from "./allocations-card";
import { RunSummaryCard } from "./summary-card";
import { RunTotals, VerifyPanel, WarningsCard } from "./totals";

export function RunDetailClient() {
  const { id } = useParams<{ id: string }>();
  const { org, can } = useOrg();
  const router = useRouter();
  const run = useRun(org.id, id);
  const verify = useVerifyRun(org.id);
  const post = usePostRun(org.id);
  const reverse = useReverseRun(org.id);
  const discard = useDiscardRun(org.id);
  const calculate = useCalculateStatement(org.id);
  const [dialog, setDialog] = useState<"post" | "reverse" | "discard" | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (run.isLoading) return <PageSkeleton />;
  if (run.error || !run.data) {
    return (
      <DetailLoadError
        error={run.error}
        noun="Calculation run"
        breadcrumbs={[{ label: "Royalties" }, { label: "Processing", href: "/royalties/runs" }]}
        backHref="/royalties/runs"
        backLabel="Back to runs"
        onRetry={() => void run.refetch()}
      />
    );
  }
  const r = run.data;
  const isAdmin = can("admin");
  const canManage = can("manager");

  const doVerify = () =>
    verify.mutate(r.id, {
      onSuccess: (result) => {
        setVerifyResult(result);
        if (result.reproducible) toast.success("Run is reproducible", { description: "Recomputing from current data gives identical allocations." });
        else toast.warning("Run no longer reproduces", { description: "Ownership, contract or line data changed since it was calculated." });
      },
      onError: (error) => toast.error("Verification failed", { description: errorMessage(error) }),
    });

  const recalculate = () =>
    calculate.mutate(r.statement_id, {
      onSuccess: (next) => {
        toast.success("Recalculated", { description: "Review the new run before posting." });
        setStale(null);
        router.push(`/royalties/runs/${next.id}`);
      },
      onError: (error) => toast.error("Recalculation failed", { description: errorMessage(error) }),
    });

  const submitReverse = async () => {
    const text = reason.trim();
    if (text.length < 3) {
      setReasonError("Explain why the run is reversed (at least 3 characters)");
      return;
    }
    try {
      await reverse.mutateAsync({ runId: r.id, reason: text });
      toast.success("Run reversed", { description: "Offsetting ledger entries were written. The statement can now be corrected and recalculated." });
      setDialog(null);
      setReason("");
    } catch (error) {
      setReasonError(errorMessage(error));
    }
  };

  return (
    <>
      <PageHeader
        title={`${r.statement_source ?? "Statement"} run`}
        meta={<RunStatusBadge status={r.status} size="md" />}
        description={`Calculated ${formatDateTime(r.created_at)} · ${basisLabel(r.allocation_basis)} basis · engine ${r.calculation_version} · ${r.line_count.toLocaleString()} lines · ${r.currency}`}
        breadcrumbs={[{ label: "Royalties" }, { label: "Processing", href: "/royalties/runs" }, { label: formatIsoDate(r.statement_period_end) }]}
        actions={
          <>
            <ButtonLink href={`/royalties/statements/${r.statement_id}`} variant="outline" leftIcon={<FileSpreadsheet aria-hidden />}>
              Statement
            </ButtonLink>
            <Button variant="outline" leftIcon={<ShieldCheck aria-hidden />} loading={verify.isPending} onClick={doVerify} disabled={r.status === "discarded"}>
              Verify
            </Button>
            {canManage && r.status === "calculated" ? (
              <Button variant="ghost" leftIcon={<Trash2 aria-hidden />} onClick={() => setDialog("discard")}>
                Discard
              </Button>
            ) : null}
            {isAdmin && r.status === "posted" ? (
              <Button variant="outline" leftIcon={<RotateCcw aria-hidden />} onClick={() => setDialog("reverse")}>
                Reverse
              </Button>
            ) : null}
            {isAdmin && r.status === "calculated" ? (
              <Button leftIcon={<BookCheck aria-hidden />} onClick={() => setDialog("post")}>
                Post to ledger
              </Button>
            ) : null}
          </>
        }
      />

      <div className="space-y-6">
        {stale ? (
          <Alert
            tone="warning"
            title="Recalculate before posting"
            action={
              canManage ? (
                <Button size="sm" onClick={recalculate} loading={calculate.isPending} leftIcon={<Calculator aria-hidden />}>
                  Recalculate
                </Button>
              ) : null
            }
          >
            {stale}
          </Alert>
        ) : null}
        {r.status === "calculated" && !isAdmin ? (
          <Alert tone="info" title="Awaiting posting">
            An admin reviews and posts this run to the payee ledger.
          </Alert>
        ) : null}
        {r.status === "posted" ? (
          <Alert tone="success" title={`Posted ${formatDateTime(r.posted_at)}`}>
            Payable amounts were written to the payee ledger as immutable earnings. Corrections require a reversal.
          </Alert>
        ) : null}
        {r.status === "reversed" ? (
          <Alert tone="warning" title={`Reversed ${formatDateTime(r.reversed_at)}`}>
            Offsetting entries were written to the ledger{r.reversal_reason ? ` — reason: “${r.reversal_reason}”` : ""}. Nothing was deleted.
          </Alert>
        ) : null}
        {r.status === "discarded" ? (
          <Alert tone="info" title="Discarded">
            This run was replaced by a newer calculation or discarded manually. It never touched the ledger.{" "}
            <Link href={`/royalties/statements/${r.statement_id}?tab=calculation`} className="font-medium underline">
              See the statement&apos;s runs
            </Link>
          </Alert>
        ) : null}

        <RunTotals run={r} />
        {verifyResult ? <VerifyPanel result={verifyResult} storedHash={r.inputs_hash} /> : null}
        <WarningsCard run={r} />
        <RunSummaryCard orgId={org.id} run={r} />
        <AllocationsCard orgId={org.id} run={r} />
      </div>

      <ConfirmDialog
        open={dialog === "post"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Post royalties to the ledger?"
        description="Posting writes one immutable earning entry per payee and currency for the payable amounts. Posted lines are locked; the only way to undo is a reversal, which writes offsetting entries."
        confirmLabel="Post to ledger"
        tone="primary"
        onConfirm={async () => {
          try {
            await post.mutateAsync(r.id);
            toast.success("Posted to ledger", { description: "Payee balances now include these earnings." });
          } catch (error) {
            if (isApiError(error) && error.code === "stale_calculation") {
              setStale(error.message || "Ownership or contract data changed since this run was calculated.");
              toast.warning("Recalculate before posting", { description: "Ownership or contract data changed since this run was calculated." });
              return;
            }
            throw error;
          }
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-muted">
          <li>The inputs hash is re-checked; if ownership or contracts changed, posting is refused and you&apos;ll be asked to recalculate.</li>
          <li>Payee profiles are created automatically for parties that don&apos;t have one.</li>
          <li>Ledger balances are accounting figures, not bank payments.</li>
        </ul>
      </ConfirmDialog>

      <Dialog
        open={dialog === "reverse"}
        onOpenChange={(open) => {
          if (!open && !reverse.isPending) {
            setDialog(null);
            setReasonError(null);
          }
        }}
        title="Reverse posted run"
        description="Offsetting reversal entries are written to every affected payee ledger. History is kept, and the statement returns to Processed so it can be corrected and recalculated."
        footer={
          <>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={reverse.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void submitReverse()} loading={reverse.isPending}>
              Reverse run
            </Button>
          </>
        }
      >
        <FormField label="Reason" required error={reasonError ?? undefined} hint="Recorded in the audit log and on the reversal entries.">
          <Textarea
            value={reason}
            maxLength={2000}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError(null);
            }}
            placeholder="e.g. Ownership split for Song One was wrong"
          />
        </FormField>
      </Dialog>

      <ConfirmDialog
        open={dialog === "discard"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Discard this run?"
        description="The calculation is kept for reference but can no longer be posted. The statement returns to Processed."
        confirmLabel="Discard run"
        onConfirm={async () => {
          await discard.mutateAsync(r.id);
          toast.success("Run discarded");
        }}
      />
    </>
  );
}
