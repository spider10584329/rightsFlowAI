"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { Schemas } from "@/lib/api/types";

export type DashboardSummary = Schemas["DashboardSummary"];
export type RoyaltiesOverTime = Schemas["RoyaltiesOverTime"];
export type RevenueBySource = Schemas["RevenueBySource"];
export type RevenueByTerritory = Schemas["RevenueByTerritory"];
export type TopWorks = Schemas["TopWorks"];
export type TopRecordings = Schemas["TopRecordings"];
export type OwnershipDistribution = Schemas["OwnershipDistribution"];
export type CatalogGrowth = Schemas["CatalogGrowth"];
export type ActivityItem = Schemas["ActivityItem"];
export type RecentStatement = Schemas["RecentStatement"];
export type ExpiringContract = Schemas["ExpiringContract"];

/** Optional `currency` (ISO 4217). Omitted means the organization's primary currency. */
export interface CurrencyParams {
  currency?: string;
}

export const dashboardKeys = {
  all: (orgId: string) => ["org", orgId, "dashboard"] as const,
  summary: (orgId: string) => ["org", orgId, "dashboard", "summary"] as const,
  chart: (orgId: string, name: string, params: object) => ["org", orgId, "dashboard", name, params] as const,
};

const base = (orgId: string) => `/organizations/${orgId}/dashboard`;

export function useDashboardSummary(orgId: string) {
  return useQuery({
    queryKey: dashboardKeys.summary(orgId),
    queryFn: ({ signal }) => api.get<DashboardSummary>(`${base(orgId)}/summary`, { signal }),
  });
}

function useChart<T>(orgId: string, name: string, params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: dashboardKeys.chart(orgId, name, params),
    queryFn: ({ signal }) => api.get<T>(`${base(orgId)}/${name}`, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useRoyaltiesOverTime(orgId: string, params: CurrencyParams & { months?: number }) {
  return useChart<RoyaltiesOverTime>(orgId, "royalties-over-time", { months: params.months ?? 12, currency: params.currency });
}

export function useRevenueBySource(orgId: string, params: CurrencyParams) {
  return useChart<RevenueBySource>(orgId, "revenue-by-source", { currency: params.currency });
}

export function useRevenueByTerritory(orgId: string, params: CurrencyParams) {
  return useChart<RevenueByTerritory>(orgId, "revenue-by-territory", { currency: params.currency });
}

export function useTopWorks(orgId: string, params: CurrencyParams & { limit?: number }) {
  return useChart<TopWorks>(orgId, "top-works", { limit: params.limit ?? 10, currency: params.currency });
}

export function useTopRecordings(orgId: string, params: CurrencyParams & { limit?: number }) {
  return useChart<TopRecordings>(orgId, "top-recordings", { limit: params.limit ?? 10, currency: params.currency });
}

export function useOwnershipDistribution(orgId: string, limit = 10) {
  return useChart<OwnershipDistribution>(orgId, "ownership-distribution", { limit });
}

export function useCatalogGrowth(orgId: string, months = 12) {
  return useChart<CatalogGrowth>(orgId, "catalog-growth", { months });
}
