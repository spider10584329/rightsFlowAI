"use client";

import { ArrowDown, ArrowUp, Check, ExternalLink, Minus, X } from "lucide-react";
import { useState } from "react";

import { compareLimits, exceededLimits } from "@/components/billing/plan-change";
import { formatMegabytes } from "@/components/billing/usage";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useBillingPlans, useChangePlan, type BillingOverview, type BillingPlan, type PlanChangeResponse } from "@/lib/api/hooks/billing";
import { PLAN_LIMIT_ROWS } from "@/lib/plans";
import { cn } from "@/lib/utils";

function limitText(key: string, value: unknown): string {
  if (value === null || value === undefined) return "Unlimited";
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return key === "max_storage_mb" ? formatMegabytes(numeric) : numeric.toLocaleString();
}

const LIMIT_LABEL: Record<string, string> = Object.fromEntries(PLAN_LIMIT_ROWS.map((row) => [row.key, row.label]));

export function PlansSection({ orgId, overview, isOwner }: { orgId: string; overview: BillingOverview; isOwner: boolean }) {
  const plans = useBillingPlans(orgId);
  const [target, setTarget] = useState<BillingPlan | null>(null);
  const currentCode = overview.subscription.plan.code;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Compare plans</h2>
          <p className="text-[13px] text-fg-muted">
            {overview.provider_configured
              ? `Plan changes go through ${overview.provider} checkout; nothing is charged until you confirm there.`
              : "No payment provider is configured: switching is recorded internally and nothing is charged."}
          </p>
        </div>
        {!isOwner ? <Badge tone="neutral">Only the owner can switch plans</Badge> : null}
      </div>
      {plans.isLoading ? (
        <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-72 rounded-xl" />
          ))}
        </div>
      ) : plans.error || !plans.data ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} compact />
      ) : (
        <ul className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          {plans.data.map((plan) => {
            const isCurrent = plan.code === currentCode;
            return (
              <li
                key={plan.id}
                className={cn("flex flex-col rounded-xl border bg-surface p-4", isCurrent ? "border-primary ring-1 ring-primary/30" : "border-border")}
                aria-current={isCurrent ? "true" : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-fg">{plan.name}</h3>
                  {isCurrent ? <Badge tone="primary">Current plan</Badge> : plan.is_development ? <Badge tone="neutral">Development</Badge> : null}
                </div>
                {plan.description ? <p className="mt-1 text-xs leading-relaxed text-fg-muted">{plan.description}</p> : null}
                <p className={cn("mt-3 font-semibold", plan.price_configured ? "text-lg text-fg" : "text-[13px] text-fg-muted")}>{plan.price_display}</p>
                <ul className="mt-4 flex-1 space-y-1.5 text-[13px]">
                  {PLAN_LIMIT_ROWS.map((row) => {
                    const value = plan.limits[row.key];
                    const isBool = typeof value === "boolean";
                    return (
                      <li key={row.key} className="flex items-start justify-between gap-2">
                        <span className="text-fg-muted">{row.label}</span>
                        <span className={cn("inline-flex items-center gap-1 text-right font-medium", isBool && !value ? "text-fg-subtle" : "text-fg")}>
                          {isBool ? value ? <Check className="size-3.5 text-success" aria-hidden /> : <X className="size-3.5" aria-hidden /> : null}
                          {limitText(row.key, value)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {isOwner && !isCurrent ? (
                  <Button className="mt-4 h-auto min-h-8 whitespace-normal py-1.5 text-center" variant={overview.subscription.plan.sort_order < plan.sort_order ? "primary" : "outline"} size="sm" onClick={() => setTarget(plan)}>
                    Switch to {plan.name}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <SwitchPlanDialog orgId={orgId} overview={overview} target={target} onClose={() => setTarget(null)} />
    </Card>
  );
}

function SwitchPlanDialog({ orgId, overview, target, onClose }: { orgId: string; overview: BillingOverview; target: BillingPlan | null; onClose: () => void }) {
  const change = useChangePlan(orgId);
  const [result, setResult] = useState<PlanChangeResponse | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  if ((target?.id ?? null) !== targetId) {
    setTargetId(target?.id ?? null);
    setResult(null);
    change.reset();
  }

  const current = overview.subscription.plan;
  const exceeded = exceededLimits(change.error);
  const comparison = target ? compareLimits(current.limits, target.limits) : [];

  const confirm = () => {
    if (!target) return;
    change.mutate(target.code, {
      onSuccess: (data) => {
        if (data.status === "checkout_required") {
          setResult(data);
          return;
        }
        if (data.status === "changed") toast.success(`Plan changed to ${target.name}`, { description: data.charged ? data.message : `${data.message}` });
        else toast.info(data.message);
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && !change.isPending && onClose()}
      title={target ? `Switch to ${target.name}?` : "Switch plan"}
      description={
        overview.provider_configured
          ? "You'll be sent to the payment provider to confirm. The plan changes once payment is confirmed."
          : "No payment provider is configured — the change is applied immediately and nothing is charged (charged: false)."
      }
      footer={
        result?.checkout_url ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <a
              href={result.checkout_url}
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-fg hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Continue to checkout <ExternalLink className="size-4" aria-hidden />
            </a>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={change.isPending}>
              Cancel
            </Button>
            <Button onClick={confirm} loading={change.isPending} disabled={Boolean(exceeded)}>
              {overview.provider_configured ? "Start checkout" : "Switch plan"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Alert tone="info" title="Checkout required">
          {result.message}
        </Alert>
      ) : (
        <div className="space-y-4">
          {comparison.length > 0 ? (
            <table className="w-full text-[13px]">
              <caption className="sr-only">Limit changes</caption>
              <thead className="text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <tr>
                  <th scope="col" className="py-1.5 font-semibold">Limit</th>
                  <th scope="col" className="py-1.5 text-right font-semibold">{current.name}</th>
                  <th scope="col" className="py-1.5 text-right font-semibold">{target?.name}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {comparison.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="py-1.5 text-left font-normal text-fg-muted">{LIMIT_LABEL[row.key] ?? row.key}</th>
                    <td className="py-1.5 text-right tabular-nums">{limitText(row.key, row.current)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        {row.direction === "up" ? <ArrowUp className="size-3 text-success" aria-label="higher" /> : row.direction === "down" ? <ArrowDown className="size-3 text-warning" aria-label="lower" /> : <Minus className="size-3 text-fg-subtle" aria-label="same" />}
                        {limitText(row.key, row.target)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {target?.notice ? <p className="text-xs text-fg-subtle">{target.notice}</p> : null}
          {exceeded ? (
            <Alert tone="danger" title="Current usage exceeds this plan's limits">
              <p>Reduce usage before switching:</p>
              <ul className="mt-1 list-disc pl-5">
                {exceeded.map((item) => (
                  <li key={item.limit}>
                    {item.current.toLocaleString()} {item.label} — {target?.name} allows {item.allowed.toLocaleString()}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : change.error ? (
            <Alert tone="danger" title="Plan not changed">
              {errorMessage(change.error)}
            </Alert>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
