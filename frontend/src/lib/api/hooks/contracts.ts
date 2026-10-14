"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { CSRF_HEADER } from "@/lib/auth/constants";
import { api, apiUrl, getCsrfToken } from "@/lib/api/client";
import { ApiError, parseApiError } from "@/lib/api/errors";
import type { MessageResponse, Page, Schemas } from "@/lib/api/types";

export type ContractListItem = Schemas["ContractListItem"];
export type ContractDetail = Schemas["ContractDetail"];
export type ContractCreate = Schemas["ContractCreate"];
export type ContractUpdate = Schemas["ContractUpdate"];
export type ContractSummary = Schemas["ContractSummary"];
export type ContractDocument = Schemas["ContractDocumentOut"];
export type ClauseScan = Schemas["ClauseScanResponse"];
export type ClauseFlag = Schemas["ClauseFlag"];
export type ContractAnalysis = Schemas["ContractAnalysisOut"];
export type ContractAnalysisReview = Schemas["ContractAnalysisReview"];
export type ContractAuditEntry = Schemas["AuditLogResponse"];

const base = (orgId: string) => ["org", orgId, "contracts"] as const;

export const contractKeys = {
  all: base,
  list: (orgId: string, params: object) => [...base(orgId), "list", params] as const,
  summary: (orgId: string) => [...base(orgId), "summary"] as const,
  expiring: (orgId: string, days: number | null) => [...base(orgId), "expiring", days] as const,
  detail: (orgId: string, id: string) => [...base(orgId), "item", id] as const,
  documents: (orgId: string, id: string) => [...base(orgId), "item", id, "documents"] as const,
  analyses: (orgId: string, id: string) => [...base(orgId), "item", id, "analyses"] as const,
  activity: (orgId: string, id: string, params: object) => [...base(orgId), "item", id, "activity", params] as const,
  options: (orgId: string, q: string) => [...base(orgId), "options", q] as const,
};

const root = (orgId: string) => `/organizations/${orgId}/contracts`;

export interface ContractQuery {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  q?: string;
  type?: string;
  status?: string;
  expiring_within_days?: number;
  party_id?: string;
  work_id?: string;
  recording_id?: string;
}

export function useContracts(orgId: string, params: ContractQuery) {
  return useQuery({
    queryKey: contractKeys.list(orgId, params),
    queryFn: ({ signal }) => api.get<Page<ContractListItem>>(root(orgId), { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

/** Small searchable list for "link a contract" pickers. */
export function useContractOptions(orgId: string, q: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: contractKeys.options(orgId, q),
    queryFn: ({ signal }) =>
      api.get<Page<ContractListItem>>(root(orgId), { query: { q: q.trim() || undefined, page: 1, page_size: 20, sort: "title" }, signal }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useContractsSummary(orgId: string) {
  return useQuery({
    queryKey: contractKeys.summary(orgId),
    queryFn: ({ signal }) => api.get<ContractSummary>(`${root(orgId)}/summary`, { signal }),
  });
}

export function useExpiringContracts(orgId: string, withinDays?: number) {
  return useQuery({
    queryKey: contractKeys.expiring(orgId, withinDays ?? null),
    queryFn: ({ signal }) =>
      api.get<ContractListItem[]>(`${root(orgId)}/expiring`, { query: { within_days: withinDays }, signal }),
  });
}

export function useContract(orgId: string, id: string | null | undefined) {
  return useQuery({
    queryKey: contractKeys.detail(orgId, id ?? ""),
    queryFn: ({ signal }) => api.get<ContractDetail>(`${root(orgId)}/${id}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreateContract(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ContractCreate) => api.post<ContractDetail>(root(orgId), { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractKeys.all(orgId) }),
  });
}

export function useUpdateContract(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ContractUpdate) => api.patch<ContractDetail>(`${root(orgId)}/${id}`, { body }),
    onSuccess: (data) => {
      qc.setQueryData(contractKeys.detail(orgId, id), data);
      void qc.invalidateQueries({ queryKey: contractKeys.all(orgId) });
    },
  });
}

export function useDeleteContract(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<MessageResponse>(`${root(orgId)}/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractKeys.all(orgId) }),
  });
}

export function useContractActivity(orgId: string, id: string, params: { page: number; page_size: number }) {
  return useQuery({
    queryKey: contractKeys.activity(orgId, id, params),
    queryFn: ({ signal }) => api.get<Page<ContractAuditEntry>>(`${root(orgId)}/${id}/activity`, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

// ----------------------------------------------------------------- documents

export function useContractDocuments(orgId: string, id: string) {
  return useQuery({
    queryKey: contractKeys.documents(orgId, id),
    queryFn: ({ signal }) => api.get<ContractDocument[]>(`${root(orgId)}/${id}/documents`, { signal }),
  });
}

/**
 * Multipart upload through the BFF with progress events. `fetch` cannot
 * report upload progress, so this uses XMLHttpRequest with the same CSRF
 * header and error envelope parsing as the API client.
 */
export async function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const token = await getCsrfToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader("accept", "application/json");
    if (token) xhr.setRequestHeader(CSRF_HEADER, token);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // keep text
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(parseApiError(xhr.status, body, xhr.getResponseHeader("x-request-id")));
    };
    xhr.onerror = () => reject(new ApiError({ status: 0, code: "network_error", message: "Network error. Check your connection and try again." }));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(formData);
  });
}

export function useUploadContractDocument(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, label, onProgress }: { file: File; label?: string; onProgress?: (fraction: number) => void }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (label?.trim()) formData.append("label", label.trim());
      return uploadWithProgress<ContractDocument>(`${root(orgId)}/${id}/documents`, formData, onProgress);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: contractKeys.documents(orgId, id) });
      void qc.invalidateQueries({ queryKey: contractKeys.detail(orgId, id) });
      void qc.invalidateQueries({ queryKey: [...contractKeys.detail(orgId, id), "activity"] });
    },
  });
}

export function useDeleteContractDocument(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.delete<MessageResponse>(`${root(orgId)}/${id}/documents/${documentId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: contractKeys.documents(orgId, id) });
      void qc.invalidateQueries({ queryKey: contractKeys.detail(orgId, id) });
    },
  });
}

export function useClauseScan(orgId: string, id: string) {
  return useMutation({
    mutationFn: (documentId: string) => api.post<ClauseScan>(`${root(orgId)}/${id}/documents/${documentId}/clause-scan`),
  });
}

// ----------------------------------------------------------------- AI analyses

const IN_FLIGHT = new Set(["queued", "running"]);

export function isAnalysisInFlight(analysis: Pick<ContractAnalysis, "status">): boolean {
  return IN_FLIGHT.has(analysis.status);
}

/** Polls every 3 s while any analysis is queued or running. */
export function useContractAnalyses(orgId: string, id: string) {
  return useQuery({
    queryKey: contractKeys.analyses(orgId, id),
    queryFn: ({ signal }) => api.get<ContractAnalysis[]>(`${root(orgId)}/${id}/analyses`, { signal }),
    refetchInterval: (query) => (query.state.data?.some(isAnalysisInFlight) ? 3000 : false),
  });
}

export function useRequestAnalysis(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.post<ContractAnalysis>(`${root(orgId)}/${id}/analyses`, { body: { document_id: documentId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractKeys.analyses(orgId, id) }),
  });
}

export function useReviewAnalysis(orgId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ analysisId, body }: { analysisId: string; body: ContractAnalysisReview }) =>
      api.post<ContractAnalysis>(`${root(orgId)}/${id}/analyses/${analysisId}/review`, { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractKeys.all(orgId) }),
  });
}
