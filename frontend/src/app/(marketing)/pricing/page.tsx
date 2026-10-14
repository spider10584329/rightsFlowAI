import { Check, FlaskConical, Minus } from "lucide-react";
import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { DEVELOPMENT_PLANS, PLAN_LIMIT_ROWS, type PlanLimits } from "@/lib/plans";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Plans",
  description: "RightsFlow AI development plans and their limits. Commercial pricing has not been configured yet.",
};

function formatLimit(key: keyof PlanLimits, value: PlanLimits[keyof PlanLimits], format?: (value: number) => string) {
  if (typeof value === "boolean") {
    return value ? (
      <>
        <Check className="mx-auto size-4 text-success" aria-hidden />
        <span className="sr-only">Included</span>
      </>
    ) : (
      <>
        <Minus className="mx-auto size-4 text-fg-subtle" aria-hidden />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  if (value === null) return "Unlimited";
  return format ? format(value) : value.toLocaleString("en-US");
}

export default function PricingPage() {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:py-20">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Plans</p>
          <h1 className="mx-auto mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-fg">Plans that scale with your catalog</h1>
          <div
            role="note"
            className="mx-auto mt-8 flex max-w-2xl items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-left text-[13px] text-warning-soft-fg"
          >
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold">Development plans — commercial pricing not yet configured.</span> The limits below are
              evaluation defaults. No prices are shown and nothing is charged; plan changes are recorded internally until a payment
              provider is enabled.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {DEVELOPMENT_PLANS.map((plan) => (
            <article
              key={plan.code}
              aria-labelledby={`${plan.code}-name`}
              className={cn(
                "relative flex flex-col rounded-2xl border bg-surface p-6 shadow-sm",
                plan.isDefault ? "border-primary/50 ring-1 ring-primary/30" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 id={`${plan.code}-name`} className="text-lg font-semibold tracking-tight text-fg">
                  {plan.name}
                </h2>
                {plan.isDefault ? <Badge tone="primary">Default for new orgs</Badge> : null}
              </div>
              <p className="mt-1.5 min-h-10 text-[13px] leading-relaxed text-fg-muted">{plan.description}</p>
              <p className="mt-5 text-sm font-medium text-fg-subtle">Price not configured</p>
              <ul className="mt-5 flex-1 space-y-2.5 border-t border-border pt-5">
                {PLAN_LIMIT_ROWS.filter((row) => typeof plan.limits[row.key] !== "boolean").map((row) => (
                  <li key={row.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-fg-muted">{row.label}</span>
                    <span className="font-semibold text-fg tabular-nums">{formatLimit(row.key, plan.limits[row.key], row.format)}</span>
                  </li>
                ))}
              </ul>
              <ButtonLink href="/register" variant={plan.isDefault ? "primary" : "outline"} className="mt-6 w-full">
                Get started
              </ButtonLink>
            </article>
          ))}
        </div>

        <div className="mt-14 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <ScrollRegion>
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="border-b border-border px-6 py-4 text-left text-[15px] font-semibold text-fg">Compare limits</caption>
              <thead className="bg-surface-2/70">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                    Limit
                  </th>
                  {DEVELOPMENT_PLANS.map((plan) => (
                    <th key={plan.code} scope="col" className="px-4 py-3 text-center text-[13px] font-semibold text-fg">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {PLAN_LIMIT_ROWS.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="px-6 py-3 text-left font-normal text-fg-muted">
                      {row.label}
                    </th>
                    {DEVELOPMENT_PLANS.map((plan) => (
                      <td key={plan.code} className="px-4 py-3 text-center font-medium text-fg tabular-nums">
                        {formatLimit(row.key, plan.limits[row.key], row.format)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </div>
        <p className="mt-6 text-center text-xs text-fg-subtle">
          Limits are enforced per organization. Owners can review usage and change plans under Settings → Billing.
        </p>
      </section>
    </>
  );
}
