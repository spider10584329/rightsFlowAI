"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { Schemas } from "@/lib/api/types";

export type BillingOverview = Schemas["BillingOverview"];
export type BillingPlan = Schemas["PlanResponse"];
export type UsageItem = Schemas["UsageItem"];
export type PlanChangeResponse = Schemas["PlanChangeResponse"];
export type CheckoutResponse = Schemas["CheckoutResponse"];
export type UsageHistory = Schemas["UsageHistoryResponse"];

export const billingKeys = {
  all: (orgId: string) => ["org", orgId, "billing"] as const,
  overview: (orgId: string) => ["org", orgId, "billing", "overview"] as const,
  usage: (orgId: string, months: number) => ["org", orgId, "billing", "usage", months] as const,
  // Plans are global, but listing them requires a session; keep them under the org root so
  // they are dropped with everything else on an organization switch.
  plans: (orgId: string) => ["org", orgId, "billing", "plans"] as const,
};

const base = (orgId: string) => `/organizations/${orgId}/billing`;

export function useBillingOverview(orgId: string) {
  return useQuery({
    queryKey: billingKeys.overview(orgId),
    queryFn: ({ signal }) => api.get<BillingOverview>(base(orgId), { signal }),
  });
}

export function useBillingPlans(orgId: string) {
  return useQuery({
    queryKey: billingKeys.plans(orgId),
    queryFn: ({ signal }) => api.get<BillingPlan[]>("/billing/plans", { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useBillingUsageHistory(orgId: string, months: number, enabled: boolean) {
  return useQuery({
    queryKey: billingKeys.usage(orgId, months),
    queryFn: ({ signal }) => api.get<UsageHistory>(`${base(orgId)}/usage`, { query: { months }, signal }),
    enabled,
  });
}

export function useChangePlan(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planCode: string) => api.put<PlanChangeResponse>(`${base(orgId)}/plan`, { body: { plan_code: planCode } }),
    onSuccess: (data) => {
      if (data.billing) qc.setQueryData(billingKeys.overview(orgId), data.billing);
      void qc.invalidateQueries({ queryKey: billingKeys.all(orgId) });
      // AI entitlement and limits follow the plan.
      void qc.invalidateQueries({ queryKey: ["org", orgId, "ai", "status"] });
    },
  });
}

export function useUpdateBillingEmail(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (billingEmail: string | null) => api.patch<BillingOverview>(base(orgId), { body: { billing_email: billingEmail } }),
    onSuccess: (data) => qc.setQueryData(billingKeys.overview(orgId), data),
  });
}

export function useStartCheckout(orgId: string) {
  return useMutation({
    mutationFn: (planCode?: string) => api.post<CheckoutResponse>(`${base(orgId)}/checkout`, { body: planCode ? { plan_code: planCode } : {} }),
  });
}
