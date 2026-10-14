"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, downloadFile } from "@/lib/api/client";
import type { Page, Schemas } from "@/lib/api/types";

// --------------------------------------------------------------------------- types

export type Payee = Schemas["PayeeResponse"];
export type BalanceRow = Schemas["BalanceRow"];
export type LedgerEntry = Schemas["LedgerEntryResponse"];
export type PayoutBatch = Schemas["PayoutBatchResponse"];
export type Payout = Schemas["PayoutResponse"];
export type PartySummary = Schemas["PartyResponse"];
export type ContractSummary = Schemas["ContractListItem"];

export type PaymentMethod = "bank_transfer" | "paypal" | "check" | "wire" | "other";

/** Only these non-sensitive reference fields are accepted by the backend. */
export interface PaymentReference {
  bank_name?: string;
  account_last4?: string;
  paypal_email?: string;
  reference?: string;
  country?: string;
}

export interface PayeeCreateInput {
  party_id: string;
  display_name?: string | null;
  email?: string | null;
  payment_method: PaymentMethod;
  payment_reference?: PaymentReference | null;
  currency: string;
  minimum_payout: string;
  hold_payments: boolean;
  tax_form_status?: string | null;
  notes?: string | null;
}

export type PayeeUpdateInput = Partial<Omit<PayeeCreateInput, "party_id">> & { is_active?: boolean };

export interface PaymentProviderInfo {
  provider: string;
  moves_money: boolean;
  message: string;
}

export interface MarkPaidInput {
  payment_date?: string | null;
  external_references?: Record<string, string> | null;
  notes?: string | null;
}

// --------------------------------------------------------------------------- keys

const orgPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;
const seg = (value: string) => encodeURIComponent(value);

export const payoutKeys = {
  all: (orgId: string) => ["org", orgId, "payouts"] as const,
  payees: (orgId: string) => ["org", orgId, "payouts", "payees"] as const,
  payeeList: (orgId: string, params: object) => ["org", orgId, "payouts", "payees", "list", params] as const,
  payee: (orgId: string, id: string) => ["org", orgId, "payouts", "payees", "detail", id] as const,
  ledger: (orgId: string, id: string, params: object) => ["org", orgId, "payouts", "payees", "ledger", id, params] as const,
  batches: (orgId: string) => ["org", orgId, "payouts", "batches"] as const,
  batchList: (orgId: string, params: object) => ["org", orgId, "payouts", "batches", "list", params] as const,
  batch: (orgId: string, id: string) => ["org", orgId, "payouts", "batches", "detail", id] as const,
  provider: (orgId: string) => ["org", orgId, "payouts", "provider"] as const,
  partySearch: (orgId: string, q: string) => ["org", orgId, "payouts", "search", "parties", q] as const,
  contractSearch: (orgId: string, q: string) => ["org", orgId, "payouts", "search", "contracts", q] as const,
};

function invalidatePayouts(qc: QueryClient, orgId: string) {
  void qc.invalidateQueries({ queryKey: payoutKeys.all(orgId) });
  void qc.invalidateQueries({ queryKey: ["org", orgId, "dashboard"] });
}

// --------------------------------------------------------------------------- payees

export interface PayeeListParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  q?: string;
  active?: boolean;
  with_balance?: boolean;
}

export function usePayees(orgId: string, params: PayeeListParams) {
  return useQuery({
    queryKey: payoutKeys.payeeList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<Payee>>(`${orgPath(orgId)}/payees`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function usePayee(orgId: string, payeeId: string) {
  return useQuery({
    queryKey: payoutKeys.payee(orgId, payeeId),
    queryFn: ({ signal }) => api.get<Payee>(`${orgPath(orgId)}/payees/${seg(payeeId)}`, { signal }),
    enabled: Boolean(payeeId),
  });
}

export function useCreatePayee(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PayeeCreateInput) => api.post<Payee>(`${orgPath(orgId)}/payees`, { body }),
    onSuccess: () => invalidatePayouts(qc, orgId),
  });
}

export function useUpdatePayee(orgId: string, payeeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PayeeUpdateInput) => api.patch<Payee>(`${orgPath(orgId)}/payees/${seg(payeeId)}`, { body }),
    onSuccess: (payee) => {
      qc.setQueryData(payoutKeys.payee(orgId, payeeId), payee);
      invalidatePayouts(qc, orgId);
    },
  });
}

export interface LedgerFilters {
  currency?: string;
  start?: string;
  end?: string;
}

export function usePayeeLedger(orgId: string, payeeId: string, filters: LedgerFilters) {
  return useQuery({
    queryKey: payoutKeys.ledger(orgId, payeeId, filters),
    queryFn: ({ signal }) =>
      api.get<LedgerEntry[]>(`${orgPath(orgId)}/payees/${seg(payeeId)}/ledger`, { query: { ...filters }, signal }),
    enabled: Boolean(payeeId),
    placeholderData: keepPreviousData,
  });
}

export function downloadPayeeStatement(orgId: string, payeeId: string, filters: LedgerFilters) {
  return downloadFile(`${orgPath(orgId)}/payees/${seg(payeeId)}/statement.csv`, undefined, { query: { ...filters } });
}

export function useRecordAdjustment(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { payee_id: string; amount: string; currency: string; description: string; effective_date?: string | null }) =>
      api.post<LedgerEntry>(`${orgPath(orgId)}/ledger/adjustments`, { body }),
    onSuccess: () => invalidatePayouts(qc, orgId),
  });
}

export function useRecordAdvance(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      payee_id: string;
      amount: string;
      currency: string;
      description: string;
      contract_id?: string | null;
      effective_date?: string | null;
    }) => api.post<LedgerEntry>(`${orgPath(orgId)}/ledger/advances`, { body }),
    onSuccess: () => invalidatePayouts(qc, orgId),
  });
}

export function useReverseLedgerEntry(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entryId, reason }: { entryId: string; reason: string }) =>
      api.post<LedgerEntry>(`${orgPath(orgId)}/ledger/${seg(entryId)}/reverse`, { body: { reason } }),
    onSuccess: () => invalidatePayouts(qc, orgId),
  });
}

// --------------------------------------------------------------------------- pickers

export function usePartySearch(orgId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: payoutKeys.partySearch(orgId, q),
    queryFn: ({ signal }) => api.get<Page<PartySummary>>(`${orgPath(orgId)}/parties`, { query: { q: q || undefined, page_size: 10 }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useContractSearch(orgId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: payoutKeys.contractSearch(orgId, q),
    queryFn: ({ signal }) => api.get<Page<ContractSummary>>(`${orgPath(orgId)}/contracts`, { query: { q: q || undefined, page_size: 10 }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

// --------------------------------------------------------------------------- batches

export function usePaymentProvider(orgId: string) {
  return useQuery({
    queryKey: payoutKeys.provider(orgId),
    queryFn: ({ signal }) => api.get<PaymentProviderInfo>(`${orgPath(orgId)}/payouts/provider`, { signal }),
    staleTime: 10 * 60_000,
  });
}

export function useBatches(orgId: string, params: { page: number; page_size: number; status?: string; sort?: string; order?: "asc" | "desc" }) {
  return useQuery({
    queryKey: payoutKeys.batchList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<PayoutBatch>>(`${orgPath(orgId)}/payouts/batches`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useBatch(orgId: string, batchId: string) {
  return useQuery({
    queryKey: payoutKeys.batch(orgId, batchId),
    queryFn: ({ signal }) => api.get<PayoutBatch>(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}`, { signal }),
    enabled: Boolean(batchId),
  });
}

function useBatchMutation<TVars>(orgId: string, request: (vars: TVars) => Promise<PayoutBatch>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (batch) => {
      qc.setQueryData(payoutKeys.batch(orgId, batch.id), batch);
      invalidatePayouts(qc, orgId);
    },
  });
}

export function useCreateBatch(orgId: string) {
  return useBatchMutation(orgId, (body: { currency: string; payee_ids?: string[] | null; notes?: string | null }) =>
    api.post<PayoutBatch>(`${orgPath(orgId)}/payouts/batches`, { body }),
  );
}

export function useAmendPayout(orgId: string, batchId: string) {
  return useBatchMutation(orgId, ({ payoutId, amount }: { payoutId: string; amount: string }) =>
    api.patch<PayoutBatch>(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/payouts/${seg(payoutId)}`, { body: { amount } }),
  );
}

export function useRemovePayout(orgId: string, batchId: string) {
  return useBatchMutation(orgId, (payoutId: string) =>
    api.delete<PayoutBatch>(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/payouts/${seg(payoutId)}`),
  );
}

export function useBatchAction(orgId: string, batchId: string, action: "submit" | "approve" | "cancel") {
  return useBatchMutation(orgId, () => api.post<PayoutBatch>(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/${action}`));
}

export function useMarkPaid(orgId: string, batchId: string) {
  return useBatchMutation(orgId, (input: MarkPaidInput) =>
    api.post<PayoutBatch>(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/mark-paid`, { body: { confirm: true, ...input } }),
  );
}

export function downloadRemittance(orgId: string, batchId: string) {
  return downloadFile(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/remittance.csv`);
}

export function downloadPayoutAdvice(orgId: string, batchId: string, payoutId: string) {
  return downloadFile(`${orgPath(orgId)}/payouts/batches/${seg(batchId)}/payouts/${seg(payoutId)}/advice.csv`);
}
