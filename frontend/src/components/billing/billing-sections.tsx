"use client";

import { Check, CreditCard, Mail, X } from "lucide-react";
import { useState } from "react";

import { formatBytes, formatMegabytes, formatUsd } from "@/components/billing/usage";
import { UsageMeter } from "@/components/billing/usage-meter";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { KeyValueList } from "@/components/ui/key-value";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import { useBillingUsageHistory, useStartCheckout, useUpdateBillingEmail, type BillingOverview } from "@/lib/api/hooks/billing";
import { PLAN_LIMIT_ROWS } from "@/lib/plans";
import { formatDate, titleCase } from "@/lib/utils";

export function CurrentPlanCard({ overview, isOwner, orgId }: { overview: BillingOverview; isOwner: boolean; orgId: string }) {
  const { subscription } = overview;
  const checkout = useStartCheckout(orgId);

  const startCheckout = () =>
    checkout.mutate(undefined, {
      onSuccess: (data) => {
        toast.info(data.message);
        window.location.assign(data.checkout_url);
      },
    });

  const checkoutError =
    checkout.error && isApiError(checkout.error) && checkout.error.code === "billing_not_configured"
      ? "No payment provider is configured on the server, so checkout isn't available. Plan changes are applied manually and nothing is charged."
      : checkout.error
        ? errorMessage(checkout.error)
        : null;

  return (
    <Card>
      <CardHeader
        title="Current plan"
        actions={
          <Badge tone={statusTone(subscription.status)} dot size="md">
            {titleCase(subscription.status)}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-fg">{subscription.plan.name}</p>
          <p className="text-[13px] text-fg-muted">{subscription.plan.price_display}</p>
        </div>
        <KeyValueList
          items={[
            { label: "Billing provider", value: overview.provider_configured ? titleCase(overview.provider) : "Manual (no payment provider)" },
            { label: "Current period", value: `${formatDate(subscription.current_period_start)} – ${subscription.current_period_end ? formatDate(subscription.current_period_end) : "open-ended"}` },
            { label: "Renewal", value: subscription.cancel_at_period_end ? "Cancels at period end" : "Continues" },
            { label: "Billing email", value: subscription.billing_email ?? "Not set" },
          ]}
        />
        {subscription.plan.notice ? (
          <Alert tone="info" title="Development plan">
            {subscription.plan.notice}
          </Alert>
        ) : null}
        {overview.notice ? <Alert tone="warning" title="No charges in manual mode">{overview.notice}</Alert> : null}
        {isOwner && overview.provider_configured ? (
          <div className="space-y-2">
            <Button leftIcon={<CreditCard aria-hidden />} onClick={startCheckout} loading={checkout.isPending}>
              Manage payment via checkout
            </Button>
            {checkoutError ? (
              <p role="alert" className="text-xs text-danger">
                {checkoutError}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

const LIMIT_LABELS: Record<string, string> = Object.fromEntries(PLAN_LIMIT_ROWS.map((row) => [row.key, row.label]));

function limitLabel(key: string, fallback: string): string {
  return LIMIT_LABELS[key] ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

export function UsageCard({ overview }: { overview: BillingOverview }) {
  return (
    <Card>
      <CardHeader title="Usage vs plan limits" description="Measured live from your organization's data." />
      <CardBody className="space-y-5">
        {overview.usage.map((item) => (
          <UsageMeter
            key={item.key}
            label={limitLabel(item.key, item.label)}
            used={item.used}
            limit={item.limit}
            percentage={item.percentage}
            exceeded={item.exceeded}
            formatValue={item.key === "max_storage_mb" ? formatMegabytes : undefined}
          />
        ))}
      </CardBody>
    </Card>
  );
}

export function FeaturesCard({ overview }: { overview: BillingOverview }) {
  const entries = Object.entries(overview.features);
  return (
    <Card>
      <CardHeader title="Features" description="Feature flags included in your plan." />
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-[13px] text-fg-muted">This plan has no optional features.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map(([key, enabled]) => (
              <li key={key} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-fg">{limitLabel(key, titleCase(key))}</span>
                <Badge tone={enabled ? "success" : "neutral"}>
                  {enabled ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
                  {enabled ? "Included" : "Not included"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BillingEmailCard({ orgId, overview }: { orgId: string; overview: BillingOverview }) {
  const update = useUpdateBillingEmail(orgId);
  const saved = overview.subscription.billing_email ?? "";
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setValue(saved);
  }

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed && (!EMAIL_RE.test(trimmed) || trimmed.length > 320)) return setError("Enter a valid email address.");
    setError(null);
    update.mutate(trimmed || null, {
      onSuccess: () => toast.success(trimmed ? "Billing email updated" : "Billing email cleared"),
      onError: (cause) => setError(fieldErrors(cause).billing_email ?? errorMessage(cause)),
    });
  };

  return (
    <Card>
      <CardHeader title="Billing contact" description="Invoices and billing notices go to this address." />
      <CardBody>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField label="Billing email" error={error ?? undefined} hint="Leave empty to clear." className="flex-1">
            <Input type="email" value={value} onChange={(event) => setValue(event.target.value)} leadingIcon={<Mail aria-hidden />} placeholder="billing@example.com" autoComplete="email" />
          </FormField>
          <Button type="submit" loading={update.isPending} disabled={value.trim() === saved} className="sm:mt-[1.625rem]">
            Save
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

const MONTH_OPTIONS = ["3", "6", "12", "24"].map((value) => ({ value, label: `Last ${value} months` }));

export function UsageHistorySection({ orgId }: { orgId: string }) {
  const [months, setMonths] = useState("12");
  const history = useBillingUsageHistory(orgId, Number(months), true);
  const data = history.data;
  const maxImports = Math.max(1, ...(data?.statement_imports ?? []).map((row) => row.statements));

  return (
    <Card>
      <CardHeader
        title="Usage history"
        description="AI requests and estimated cost by month and feature, statement imports by month, and current storage."
        actions={<Select size="sm" className="w-40" aria-label="History period" value={months} onValueChange={setMonths} options={MONTH_OPTIONS} />}
      />
      {history.isLoading ? (
        <CardBody>
          <Skeleton className="h-48 w-full" />
        </CardBody>
      ) : history.error || !data ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} compact />
      ) : (
        <CardBody className="grid gap-6 lg:grid-cols-3">
          <section aria-labelledby="hist-ai" className="space-y-3 lg:col-span-2">
            <h3 id="hist-ai" className="text-sm font-semibold text-fg">
              AI usage since {formatDate(data.since)}
            </h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Requests", data.ai_totals.requests.toLocaleString()],
                ["Input tokens", data.ai_totals.input_tokens.toLocaleString()],
                ["Output tokens", data.ai_totals.output_tokens.toLocaleString()],
                ["Estimated cost", formatUsd(data.ai_totals.estimated_cost_usd)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-surface-2/50 px-3 py-2">
                  <dt className="text-2xs text-fg-subtle">{label}</dt>
                  <dd className="text-sm font-semibold text-fg">{value}</dd>
                </div>
              ))}
            </dl>
            {data.ai_usage.length === 0 ? (
              <p className="text-[13px] text-fg-muted">No AI requests in this period.</p>
            ) : (
              <ScrollRegion>
                <table className="w-full min-w-[30rem] text-[13px]">
                  <caption className="sr-only">AI usage by month and feature</caption>
                  <thead className="text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                    <tr className="border-b border-border">
                      <th scope="col" className="py-2 font-semibold">Month</th>
                      <th scope="col" className="py-2 font-semibold">Feature</th>
                      <th scope="col" className="py-2 text-right font-semibold">Requests</th>
                      <th scope="col" className="py-2 text-right font-semibold">Tokens</th>
                      <th scope="col" className="py-2 text-right font-semibold">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.ai_usage.map((row) => (
                      <tr key={`${row.month}-${row.feature}`}>
                        <td className="py-2 tabular-nums">{row.month}</td>
                        <td className="py-2">{titleCase(row.feature)}</td>
                        <td className="py-2 text-right tabular-nums">{row.requests.toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums">{(row.input_tokens + row.output_tokens).toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums">{formatUsd(row.estimated_cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </section>
          <div className="space-y-6">
            <section aria-labelledby="hist-imports" className="space-y-2">
              <h3 id="hist-imports" className="text-sm font-semibold text-fg">Statement imports</h3>
              {data.statement_imports.length === 0 ? (
                <p className="text-[13px] text-fg-muted">No statements imported in this period.</p>
              ) : (
                <ul className="space-y-2">
                  {data.statement_imports.map((row) => (
                    <li key={row.month} className="text-[13px]">
                      <div className="flex justify-between">
                        <span className="tabular-nums text-fg-muted">{row.month}</span>
                        <span className="font-medium tabular-nums">{row.statements.toLocaleString()}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-2" aria-hidden>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(row.statements / maxImports) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="hist-storage" className="space-y-2">
              <h3 id="hist-storage" className="text-sm font-semibold text-fg">Storage</h3>
              <p className="text-[13px] text-fg-muted">
                {data.storage.files.toLocaleString()} files · {formatBytes(data.storage.bytes)}
                {data.storage.limit_mb !== null && data.storage.limit_mb !== undefined ? ` of ${formatMegabytes(data.storage.limit_mb)}` : " · unlimited"}
              </p>
              {data.storage.by_category.length > 0 ? (
                <ul className="divide-y divide-border text-[13px]">
                  {data.storage.by_category.map((category) => (
                    <li key={category.category} className="flex justify-between py-1.5">
                      <span>{titleCase(category.category)}</span>
                      <span className="tabular-nums text-fg-muted">
                        {category.files.toLocaleString()} · {formatBytes(category.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>
        </CardBody>
      )}
    </Card>
  );
}
