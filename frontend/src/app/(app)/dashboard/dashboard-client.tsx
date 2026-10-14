"use client";

import { Activity, Coins, Info, RotateCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { ExpiringContractsList, RecentActivityList, RecentStatementsList } from "@/components/dashboard/activity-lists";
import {
  CatalogGrowthCard,
  OwnershipCard,
  RevenueBySourceCard,
  RevenueByTerritoryCard,
  RoyaltiesOverTimeCard,
  TopRecordingsCard,
  TopWorksCard,
} from "@/components/dashboard/chart-sections";
import { currencyOptions, resolveCurrency } from "@/components/dashboard/format";
import { CatalogKpis, isNewOrganization, MoneyKpis, OnboardingCard } from "@/components/dashboard/kpis";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { dashboardKeys, useDashboardSummary } from "@/lib/api/hooks/dashboard";
import { formatDateTime } from "@/lib/utils";

export function DashboardClient() {
  const { org, can } = useOrg();
  const canEdit = can("manager");
  const summary = useDashboardSummary(org.id);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const data = summary.data;
  const primary = data?.primary_currency ?? org.defaultCurrency;
  const options = currencyOptions(
    primary,
    data?.reported_royalties.all_time.other_currencies,
    data?.payable_balances.other_currencies,
    data?.unmatched_transactions.other_currencies,
  );
  const currency = resolveCurrency(searchParams.get("currency"), options, primary);

  const setCurrency = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === primary) params.delete("currency");
    else params.set("currency", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: dashboardKeys.all(org.id) });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Executive overview of ${org.name}, computed from your own catalog, rights, contracts and royalty data.`}
        meta={data ? <span className="text-xs text-fg-subtle">As of {formatDateTime(data.as_of)}</span> : null}
        actions={
          <>
            <ButtonLink href="/settings/jobs" variant="ghost" size="sm" leftIcon={<Activity aria-hidden />}>
              Background jobs
            </ButtonLink>
            <Button variant="outline" size="sm" onClick={refresh} loading={summary.isFetching && !summary.isLoading} leftIcon={<RotateCw aria-hidden />}>
              Refresh
            </Button>
          </>
        }
      />

      {summary.isLoading ? (
        <DashboardSkeleton />
      ) : summary.error || !data ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />
      ) : (
        <div className="space-y-6">
          {isNewOrganization(data) ? <OnboardingCard summary={data} canEdit={canEdit} /> : null}

          <section aria-label="Royalty and payable figures" className="space-y-4">
            <MoneyKpis summary={data} />
          </section>
          <section aria-label="Catalog, contracts and conflicts" className="space-y-4">
            <CatalogKpis summary={data} />
          </section>

          <section aria-labelledby="analytics-heading" className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-xs sm:flex-row sm:items-center">
              <h2 id="analytics-heading" className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Coins className="size-4 text-fg-subtle" aria-hidden /> Royalty analytics
              </h2>
              <div className="flex items-center gap-2 sm:ml-4">
                <label htmlFor="dashboard-currency" className="text-[13px] text-fg-muted">
                  Currency
                </label>
                <Select
                  id="dashboard-currency"
                  size="sm"
                  className="w-36"
                  value={currency}
                  onValueChange={setCurrency}
                  options={options.map((code) => ({ value: code, label: code === primary ? `${code} (primary)` : code }))}
                />
              </div>
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle sm:ml-auto sm:max-w-md">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Charts show amounts reported in {currency} only. Other currencies are listed separately — no FX conversion is applied.
              </p>
            </div>

            <RoyaltiesOverTimeCard orgId={org.id} currency={currency} canEdit={canEdit} />
            <div className="grid gap-4 lg:grid-cols-2">
              <RevenueBySourceCard orgId={org.id} currency={currency} canEdit={canEdit} />
              <RevenueByTerritoryCard orgId={org.id} currency={currency} canEdit={canEdit} />
              <TopWorksCard orgId={org.id} currency={currency} canEdit={canEdit} />
              <TopRecordingsCard orgId={org.id} currency={currency} canEdit={canEdit} />
            </div>
          </section>

          <section aria-label="Catalog and ownership analytics" className="grid gap-4 xl:grid-cols-2">
            <CatalogGrowthCard orgId={org.id} canEdit={canEdit} />
            <OwnershipCard orgId={org.id} canEdit={canEdit} />
          </section>

          <section aria-label="Recent activity" className="grid gap-4 lg:grid-cols-3">
            <RecentActivityList items={data.recent_catalog_activity} canEdit={canEdit} />
            <RecentStatementsList items={data.recent_statements} canEdit={canEdit} />
            <ExpiringContractsList items={data.upcoming_contract_expirations} canEdit={canEdit} />
          </section>
        </div>
      )}
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading dashboard">
      <div className="grid gap-4 lg:grid-cols-4">
        <Skeleton className="h-48 rounded-xl lg:col-span-2" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
