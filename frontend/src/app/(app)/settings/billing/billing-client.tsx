"use client";

import { Activity } from "lucide-react";

import { BillingEmailCard, CurrentPlanCard, FeaturesCard, UsageCard, UsageHistorySection } from "@/components/billing/billing-sections";
import { PlansSection } from "@/components/billing/plans-section";
import { useOrg } from "@/components/session/org-provider";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useBillingOverview } from "@/lib/api/hooks/billing";

export function BillingClient() {
  const { org, can } = useOrg();
  const isOwner = org.role === "owner";
  const isAdmin = can("admin");
  const overview = useBillingOverview(org.id);
  const data = overview.data;

  return (
    <>
      <PageHeader
        title="Billing"
        description={`Plan, usage and limits for ${org.name}.`}
        breadcrumbs={[{ label: "Admin" }, { label: "Billing" }]}
        actions={
          <ButtonLink href="/settings/jobs" variant="outline" size="sm" leftIcon={<Activity aria-hidden />}>
            Background jobs
          </ButtonLink>
        }
      />
      {overview.isLoading ? (
        <div className="space-y-4" role="status" aria-label="Loading billing">
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-80 rounded-xl" />
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : overview.error || !data ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <CurrentPlanCard overview={data} isOwner={isOwner} orgId={org.id} />
            <div className="grid gap-4 lg:col-span-2 lg:grid-cols-[1.5fr_1fr]">
              <UsageCard overview={data} />
              <div className="space-y-4">
                <FeaturesCard overview={data} />
                {isOwner ? <BillingEmailCard orgId={org.id} overview={data} /> : null}
              </div>
            </div>
          </div>
          <PlansSection orgId={org.id} overview={data} isOwner={isOwner} />
          {isAdmin ? <UsageHistorySection orgId={org.id} /> : null}
        </div>
      )}
    </>
  );
}
