"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { MessageResponse, Page, Schemas } from "@/lib/api/types";

// ----------------------------------------------------------------- types (generated shapes)

export type AssetType = "work" | "recording";
export type RightsType = "performance" | "mechanical" | "sync" | "print" | "master" | "neighbouring";
export type ShareRole = Schemas["SplitEntryIn"]["role"];

export type Share = Schemas["ShareResponse"];
export type ShareMutationResult = Schemas["ShareMutationResponse"];
export type SplitEntry = Schemas["SplitEntryIn"];
export type ProposedShare = Schemas["ProposedShare"];
export type ValidationResult = Schemas["ValidationResult"];
export type RightsValidationIssue = Schemas["app__schemas__rights__ValidationIssue"];
export type TotalSegment = Schemas["TotalSegment"];
export type OwnershipSummary = Schemas["OwnershipSummary"];
export type OwnershipRights = Schemas["OwnershipRightsSummary"];
export type OwnershipShareLine = Schemas["OwnershipShareLine"];
export type ConflictBrief = Schemas["ConflictBrief"];
export type RightsConflict = Schemas["ConflictResponse"];
export type ConflictScanResult = Schemas["ConflictScanResponse"];
export type ConflictExplanation = Schemas["ConflictExplainResponse"];
export type RightsSummary = Schemas["RightsSummary"];
export type SplitRule = Schemas["SplitRuleResponse"];
export type SplitRuleCreate = Schemas["SplitRuleCreate"];
export type SplitRuleUpdate = Schemas["SplitRuleUpdate"];
export type SplitSheet = Schemas["SplitSheetResponse"];
export type SplitSheetCreate = Schemas["SplitSheetCreate"];
export type SplitSheetUpdate = Schemas["SplitSheetUpdate"];
export type SplitSheetApply = Schemas["SplitSheetApply"];
export type SplitSheetApplyResult = Schemas["SplitSheetApplyResponse"];
export type SplitsReplaceResult = Schemas["SplitsReplaceResponse"];
export type AuditEntry = Schemas["AuditLogResponse"];
export type WorkItem = Schemas["WorkResponse"];
export type RecordingItem = Schemas["RecordingResponse"];
export type PartyItem = Schemas["PartyResponse"];

export type ConflictAction = "acknowledge" | "resolve" | "dismiss" | "reopen";

// ----------------------------------------------------------------- keys

const base = (orgId: string) => ["org", orgId, "rights"] as const;

export const rightsKeys = {
  all: base,
  summary: (orgId: string) => [...base(orgId), "summary"] as const,
  asset: (orgId: string, assetType: string, assetId: string) => [...base(orgId), "asset", assetType, assetId] as const,
  ownership: (orgId: string, assetType: string, assetId: string, params: object) =>
    [...base(orgId), "asset", assetType, assetId, "ownership", params] as const,
  shares: (orgId: string, assetType: string, assetId: string) => [...base(orgId), "asset", assetType, assetId, "shares"] as const,
  history: (orgId: string, assetType: string, assetId: string, params: object) =>
    [...base(orgId), "asset", assetType, assetId, "history", params] as const,
  conflicts: (orgId: string) => [...base(orgId), "conflicts"] as const,
  conflictList: (orgId: string, params: object) => [...base(orgId), "conflicts", "list", params] as const,
  conflict: (orgId: string, id: string) => [...base(orgId), "conflicts", "item", id] as const,
  rules: (orgId: string) => [...base(orgId), "rules"] as const,
  sheets: (orgId: string) => [...base(orgId), "sheets"] as const,
  sheetList: (orgId: string, params: object) => [...base(orgId), "sheets", "list", params] as const,
  catalogSearch: (orgId: string, kind: string, q: string) => ["org", orgId, "rights-pickers", kind, q] as const,
  catalogItem: (orgId: string, kind: string, id: string) => ["org", orgId, "rights-pickers", kind, "item", id] as const,
};

const root = (orgId: string) => `/organizations/${orgId}/rights`;

function useInvalidateRights(orgId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: rightsKeys.all(orgId) });
}

// ----------------------------------------------------------------- summary & asset ownership

export function useRightsSummary(orgId: string) {
  return useQuery({
    queryKey: rightsKeys.summary(orgId),
    queryFn: ({ signal }) => api.get<RightsSummary>(`${root(orgId)}/summary`, { signal }),
  });
}

export interface OwnershipParams {
  on_date?: string;
  territory?: string;
}

export function useAssetOwnership(orgId: string, assetType: AssetType | null, assetId: string | null, params: OwnershipParams) {
  return useQuery({
    queryKey: rightsKeys.ownership(orgId, assetType ?? "", assetId ?? "", params),
    queryFn: ({ signal }) =>
      api.get<OwnershipSummary>(`${root(orgId)}/assets/${assetType}/${assetId}/ownership`, {
        query: { on_date: params.on_date || undefined, territory: params.territory || undefined },
        signal,
      }),
    enabled: Boolean(assetType && assetId),
    placeholderData: keepPreviousData,
  });
}

/** Every share of an asset (any status, newest first), used by the splits editor and share actions. */
export function useAssetShares(orgId: string, assetType: AssetType | null, assetId: string | null) {
  return useQuery({
    queryKey: rightsKeys.shares(orgId, assetType ?? "", assetId ?? ""),
    queryFn: async ({ signal }) => {
      const key = assetType === "work" ? "work_id" : "recording_id";
      const items: Share[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const result = await api.get<Page<Share>>(`${root(orgId)}/shares`, {
          query: { [key]: assetId, page, page_size: 200, sort: "created_at", order: "desc" },
          signal,
        });
        items.push(...result.items);
        if (page >= result.pages) break;
      }
      return items;
    },
    enabled: Boolean(assetType && assetId),
  });
}

export function useAssetHistory(orgId: string, assetType: AssetType, assetId: string, params: { page: number; page_size: number }) {
  return useQuery({
    queryKey: rightsKeys.history(orgId, assetType, assetId, params),
    queryFn: ({ signal }) =>
      api.get<Page<AuditEntry>>(`${root(orgId)}/assets/${assetType}/${assetId}/history`, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useValidateShares(orgId: string) {
  return useMutation({
    mutationFn: (body: { asset_type: AssetType; asset_id?: string | null; shares: ProposedShare[]; include_existing?: boolean }) =>
      api.post<ValidationResult>(`${root(orgId)}/validate`, { body }),
  });
}

export function useReplaceSplits(orgId: string, assetType: AssetType, assetId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (body: { rights_type: RightsType; shares: SplitEntry[]; reason?: string | null }) =>
      api.put<SplitsReplaceResult>(`${root(orgId)}/assets/${assetType}/${assetId}/splits`, { body }),
    onSuccess: () => void invalidate(),
  });
}

export type ShareActionInput =
  | { action: "verify"; shareId: string; notes?: string | null }
  | { action: "dispute"; shareId: string; reason: string }
  | { action: "archive"; shareId: string }
  | { action: "supersede"; shareId: string; body: Schemas["ShareSupersede"] };

export function useShareAction(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (input: ShareActionInput) => {
      const path = `${root(orgId)}/shares/${input.shareId}`;
      switch (input.action) {
        case "verify":
          return api.post<ShareMutationResult>(`${path}/verify`, { body: { notes: input.notes || null } });
        case "dispute":
          return api.post<ShareMutationResult>(`${path}/dispute`, { body: { reason: input.reason } });
        case "archive":
          return api.delete<ShareMutationResult>(path);
        case "supersede":
          return api.post<ShareMutationResult>(`${path}/supersede`, { body: input.body });
      }
    },
    onSuccess: () => void invalidate(),
  });
}

// ----------------------------------------------------------------- conflicts

export interface ConflictQuery {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  status?: string;
  severity?: string;
  type?: string;
  rights_type?: string;
  work_id?: string;
  recording_id?: string;
}

export function useConflicts(orgId: string, params: ConflictQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: rightsKeys.conflictList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<RightsConflict>>(`${root(orgId)}/conflicts`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useConflict(orgId: string, id: string | null) {
  return useQuery({
    queryKey: rightsKeys.conflict(orgId, id ?? ""),
    queryFn: ({ signal }) => api.get<RightsConflict>(`${root(orgId)}/conflicts/${id}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useConflictTransition(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: ({ id, action, notes }: { id: string; action: ConflictAction; notes?: string | null }) =>
      api.post<RightsConflict>(`${root(orgId)}/conflicts/${id}/${action}`, { body: { notes: notes?.trim() || null } }),
    onSuccess: () => void invalidate(),
  });
}

export function useScanConflicts(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (body: { asset_type?: AssetType; asset_id?: string } | undefined) =>
      api.post<ConflictScanResult>(`${root(orgId)}/conflicts/scan`, { body: body ?? {} }),
    onSuccess: () => void invalidate(),
  });
}

/** Advisory AI explanation (does not change the conflict). 503 `ai_not_configured` when no provider. */
export function useExplainConflict(orgId: string) {
  return useMutation({
    mutationFn: (conflictId: string) => api.post<ConflictExplanation>(`/organizations/${orgId}/ai/conflicts/${conflictId}/explain`),
  });
}

// ----------------------------------------------------------------- split rules

export function useSplitRules(orgId: string) {
  return useQuery({
    queryKey: rightsKeys.rules(orgId),
    queryFn: ({ signal }) => api.get<SplitRule[]>(`${root(orgId)}/split-rules`, { signal }),
  });
}

export function useCreateSplitRule(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (body: SplitRuleCreate) => api.post<SplitRule>(`${root(orgId)}/split-rules`, { body }),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateSplitRule(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SplitRuleUpdate }) => api.patch<SplitRule>(`${root(orgId)}/split-rules/${id}`, { body }),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteSplitRule(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (id: string) => api.delete<MessageResponse>(`${root(orgId)}/split-rules/${id}`),
    onSuccess: () => void invalidate(),
  });
}

// ----------------------------------------------------------------- split sheets

export interface SplitSheetQuery {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  status?: string;
  work_id?: string;
}

export function useSplitSheets(orgId: string, params: SplitSheetQuery) {
  return useQuery({
    queryKey: rightsKeys.sheetList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<SplitSheet>>(`${root(orgId)}/split-sheets`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCreateSplitSheet(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (body: SplitSheetCreate) => api.post<SplitSheet>(`${root(orgId)}/split-sheets`, { body }),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateSplitSheet(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SplitSheetUpdate }) => api.patch<SplitSheet>(`${root(orgId)}/split-sheets/${id}`, { body }),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteSplitSheet(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: (id: string) => api.delete<MessageResponse>(`${root(orgId)}/split-sheets/${id}`),
    onSuccess: () => void invalidate(),
  });
}

export function useApplySplitSheet(orgId: string) {
  const invalidate = useInvalidateRights(orgId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SplitSheetApply }) =>
      api.post<SplitSheetApplyResult>(`${root(orgId)}/split-sheets/${id}/apply`, { body }),
    onSuccess: () => void invalidate(),
  });
}

// ----------------------------------------------------------------- catalog pickers (read-only)

export type CatalogKind = "works" | "recordings" | "parties";
type CatalogItem<K extends CatalogKind> = K extends "works" ? WorkItem : K extends "recordings" ? RecordingItem : PartyItem;

/** Debounced search against the catalog list endpoints, for pickers. */
export function useCatalogSearch<K extends CatalogKind>(orgId: string, kind: K, q: string, options: { enabled?: boolean; status?: string } = {}) {
  return useQuery({
    queryKey: [...rightsKeys.catalogSearch(orgId, kind, q), options.status ?? null],
    queryFn: ({ signal }) =>
      api.get<Page<CatalogItem<K>>>(`/organizations/${orgId}/${kind}`, {
        query: { q: q.trim() || undefined, page: 1, page_size: 20, status: options.status },
        signal,
      }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useCatalogItem<K extends CatalogKind>(orgId: string, kind: K, id: string | null | undefined) {
  return useQuery({
    queryKey: rightsKeys.catalogItem(orgId, kind, id ?? ""),
    queryFn: ({ signal }) => api.get<CatalogItem<K>>(`/organizations/${orgId}/${kind}/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}
