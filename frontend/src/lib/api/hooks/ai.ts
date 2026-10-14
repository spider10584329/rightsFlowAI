"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { Page, Schemas } from "@/lib/api/types";

export type AIStatus = Schemas["AIStatusResponse"];
export type AIUsagePage = Schemas["AIUsagePage"];
export type AIUsageRecord = Schemas["AIUsageRecordResponse"];
export type AISuggestion = Schemas["AISuggestionResponse"];
export type AssistantResponse = Schemas["AssistantResponse"];
export type ChatTurn = Schemas["ChatTurn"];
export type SearchResponse = Schemas["SearchResponse"];
export type SearchResult = Schemas["SearchResult"];
export type MetadataSuggestionResponse = Schemas["MetadataSuggestionResponse"];
export type SuggestionApplyResponse = Schemas["SuggestionApplyResponse"];
export type DuplicateList = Schemas["DuplicateListResponse"];
export type DuplicateCandidate = Schemas["app__schemas__ai__DuplicateCandidate"];
export type DuplicateExplainResponse = Schemas["DuplicateExplainResponse"];
export type AnomalyReport = Schemas["AnomalyReport"];
export type Anomaly = Schemas["Anomaly"];
export type AnomalySummary = Schemas["AnomalySummaryResponse"];
export type Completeness = Schemas["CompletenessResponse"];
export type ReportSummary = Schemas["ReportSummaryResponse"];
export type ReportType = Schemas["ReportSummaryRequest"]["report_type"];
export type CleanupEntityType = Schemas["MetadataSuggestionRequest"]["entity_type"];
export type DuplicateEntityType = Schemas["DuplicateExplainRequest"]["entity_type"];
export type SuggestionStatus = "pending" | "approved" | "rejected" | "applied";

export const aiKeys = {
  all: (orgId: string) => ["org", orgId, "ai"] as const,
  status: (orgId: string) => ["org", orgId, "ai", "status"] as const,
  usage: (orgId: string, params: object) => ["org", orgId, "ai", "usage", params] as const,
  suggestions: (orgId: string) => ["org", orgId, "ai", "suggestions"] as const,
  suggestionList: (orgId: string, params: object) => ["org", orgId, "ai", "suggestions", params] as const,
  duplicates: (orgId: string, entityType: string) => ["org", orgId, "ai", "duplicates", entityType] as const,
  anomalies: (orgId: string, months: number) => ["org", orgId, "ai", "anomalies", months] as const,
  completeness: (orgId: string) => ["org", orgId, "ai", "completeness"] as const,
  records: (orgId: string, entityType: string, q: string) => ["org", orgId, "ai", "record-picker", entityType, q] as const,
};

const base = (orgId: string) => `/organizations/${orgId}/ai`;

export function useAIStatus(orgId: string) {
  return useQuery({
    queryKey: aiKeys.status(orgId),
    queryFn: ({ signal }) => api.get<AIStatus>(`${base(orgId)}/status`, { signal }),
  });
}

/** Admin: one minimal real provider request (counts as one AI request). */
export function useCheckAIConnection(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AIStatus>(`${base(orgId)}/status/check`),
    onSuccess: (status) => qc.setQueryData(aiKeys.status(orgId), status),
    // A failed check is recorded as usage; refresh so the banner shows it.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: aiKeys.status(orgId) });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "ai", "usage"] });
    },
  });
}

export interface AIUsageParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  feature?: string;
  status?: string;
}

export function useAIUsage(orgId: string, params: AIUsageParams) {
  return useQuery({
    queryKey: aiKeys.usage(orgId, params),
    queryFn: ({ signal }) => api.get<AIUsagePage>(`${base(orgId)}/usage`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

/** AI calls record usage, so status and usage are refreshed after each one. */
function useInvalidateUsage(orgId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: aiKeys.status(orgId) });
    void qc.invalidateQueries({ queryKey: ["org", orgId, "ai", "usage"] });
  };
}

export function useAssistant(orgId: string) {
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { question: string; history: ChatTurn[] }) => api.post<AssistantResponse>(`${base(orgId)}/assistant`, { body }),
    onSettled: invalidate,
  });
}

export function useSmartSearch(orgId: string) {
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { query: string; limit: number }) => api.post<SearchResponse>(`${base(orgId)}/search`, { body }),
    onSettled: invalidate,
  });
}

export interface SuggestionParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  status?: SuggestionStatus;
  entity_type?: string;
}

export function useSuggestions(orgId: string, params: SuggestionParams) {
  return useQuery({
    queryKey: aiKeys.suggestionList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<AISuggestion>>(`${base(orgId)}/suggestions`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useGenerateSuggestions(orgId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { entity_type: CleanupEntityType; entity_id: string }) =>
      api.post<MetadataSuggestionResponse>(`${base(orgId)}/metadata-suggestions`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.suggestions(orgId) }),
    onSettled: invalidate,
  });
}

export function useApproveSuggestion(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SuggestionApplyResponse>(`${base(orgId)}/suggestions/${id}/approve`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: aiKeys.suggestions(orgId) });
      // Applied changes edit catalog records.
      void qc.invalidateQueries({ queryKey: ["org", orgId, "ai", "completeness"] });
    },
  });
}

export function useRejectSuggestion(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<AISuggestion>(`${base(orgId)}/suggestions/${id}/reject`, { body: reason ? { reason } : {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.suggestions(orgId) }),
  });
}

export function useDuplicateCandidates(orgId: string, entityType: DuplicateEntityType) {
  return useQuery({
    queryKey: aiKeys.duplicates(orgId, entityType),
    queryFn: ({ signal }) =>
      api.get<DuplicateList>(`${base(orgId)}/duplicates`, { query: { entity_type: entityType, limit: 100 }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useExplainDuplicate(orgId: string) {
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { entity_type: DuplicateEntityType; ids: string[] }) =>
      api.post<DuplicateExplainResponse>(`${base(orgId)}/duplicates/explain`, { body }),
    onSettled: invalidate,
  });
}

export function useAnomalies(orgId: string, months: number) {
  return useQuery({
    queryKey: aiKeys.anomalies(orgId, months),
    queryFn: ({ signal }) => api.get<AnomalyReport>(`${base(orgId)}/anomalies`, { query: { months }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useAnomalySummary(orgId: string) {
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { months: number }) => api.post<AnomalySummary>(`${base(orgId)}/anomalies/summary`, { body }),
    onSettled: invalidate,
  });
}

export function useCompleteness(orgId: string) {
  return useQuery({
    queryKey: aiKeys.completeness(orgId),
    queryFn: ({ signal }) => api.get<Completeness>(`${base(orgId)}/completeness`, { signal }),
  });
}

export function useReportSummary(orgId: string) {
  const invalidate = useInvalidateUsage(orgId);
  return useMutation({
    mutationFn: (body: { report_type: ReportType; period_start?: string | null; period_end?: string | null }) =>
      api.post<ReportSummary>(`${base(orgId)}/reports/summary`, { body }),
    onSettled: invalidate,
  });
}

export interface PickerRecord {
  id: string;
  title: string;
  subtitle: string | null;
}

const PICKER_PATHS: Record<CleanupEntityType, string> = { work: "works", recording: "recordings", party: "parties" };

/** Searches catalog records to pick the target of a metadata suggestion. */
export function useRecordPicker(orgId: string, entityType: CleanupEntityType, q: string, enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.records(orgId, entityType, q),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<PickerRecord[]> => {
      const query = { page: 1, page_size: 10, q: q || undefined };
      const path = `/organizations/${orgId}/${PICKER_PATHS[entityType]}`;
      if (entityType === "work") {
        const page = await api.get<Page<Schemas["WorkResponse"]>>(path, { query, signal });
        return page.items.map((w) => ({ id: w.id, title: w.title, subtitle: w.iswc ?? null }));
      }
      if (entityType === "recording") {
        const page = await api.get<Page<Schemas["RecordingResponse"]>>(path, { query, signal });
        return page.items.map((r) => ({
          id: r.id,
          title: r.title,
          subtitle: [r.display_artist, r.isrc].filter(Boolean).join(" · ") || null,
        }));
      }
      const page = await api.get<Page<Schemas["PartyResponse"]>>(path, { query, signal });
      return page.items.map((p) => ({ id: p.id, title: p.name, subtitle: p.ipi_number ?? null }));
    },
  });
}
