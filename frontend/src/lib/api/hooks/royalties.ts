"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, downloadFile } from "@/lib/api/client";
import type { Page, ReferenceItem, Schemas } from "@/lib/api/types";

// --------------------------------------------------------------------------- types

export type Statement = Schemas["StatementResponse"];
export type StatementPreview = Schemas["StatementPreview"];
export type StatementLine = Schemas["StatementLineResponse"];
export type Reconciliation = Schemas["ReconciliationResponse"];
export type Run = Schemas["RunResponse"];
export type Allocation = Schemas["AllocationResponse"];
export type RunSummaryRow = Schemas["RunSummaryRow"];
export type UnmatchedGroup = Schemas["UnmatchedGroup"];
export type AnomalyReport = Schemas["AnomalyReport"];
export type Anomaly = Schemas["Anomaly"];
export type StatementClassification = Schemas["StatementClassifyResponse"];
export type Job = Schemas["JobResponse"];
export type RecordingSummary = Schemas["RecordingResponse"];
export type WorkSummary = Schemas["WorkResponse"];

export interface StatementError {
  row: number | null;
  errors: string[];
}

export interface LatestRunSummary {
  id: string;
  status: string;
  total_payable: string;
  total_retained: string;
  total_unallocated: string;
}

export interface AdapterOption {
  key: string;
  label: string;
  description: string;
}

export interface VerifyResult {
  run_id: string;
  inputs_unchanged: boolean;
  allocations_match: boolean;
  reproducible: boolean;
  stored_hash: string;
  current_hash: string;
  calculation_version: string;
}

export interface ReportResult {
  report_type: string;
  title: string;
  columns: string[];
  rows: Record<string, string | number | null>[];
  totals_by_currency: Record<string, string>;
  /** Rows before the display limit; totals always cover all of them. */
  row_count?: number;
  truncated?: boolean;
  filters: { period_start: string | null; period_end: string | null; currency: string | null };
}

export interface ReportFilters {
  period_start?: string;
  period_end?: string;
  currency?: string;
}

export interface StatementListParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  status?: string;
  source_category?: string;
  q?: string;
  period_from?: string;
  period_to?: string;
}

export interface LineListParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  match_status?: string;
  valid?: boolean;
  q?: string;
}

export interface AllocationListParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  allocation_type?: string;
  party_id?: string;
  reason?: string;
  line_id?: string;
}

export interface StatementUploadInput {
  file: File;
  source_name: string;
  source_category: string;
  period_start: string;
  period_end: string;
  currency: string;
  default_rights_type?: string;
  reported_total?: string;
  notes?: string;
}

export type MatchAction = "match" | "ignore" | "unmatch";

export interface LineMatchInput {
  action: MatchAction;
  recording_id?: string | null;
  work_id?: string | null;
}

export interface BulkMatchInput extends LineMatchInput {
  line_ids?: string[];
  match_key?: "isrc" | "title" | "title_artist";
  key_line_id?: string;
}

// --------------------------------------------------------------------------- keys & paths

const orgPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;
const royaltiesPath = (orgId: string) => `${orgPath(orgId)}/royalties`;
const seg = (value: string) => encodeURIComponent(value);

export const royaltyKeys = {
  all: (orgId: string) => ["org", orgId, "royalties"] as const,
  statements: (orgId: string) => ["org", orgId, "royalties", "statements"] as const,
  statementList: (orgId: string, params: object) => ["org", orgId, "royalties", "statements", "list", params] as const,
  statement: (orgId: string, id: string) => ["org", orgId, "royalties", "statements", "detail", id] as const,
  preview: (orgId: string, id: string) => ["org", orgId, "royalties", "statements", "preview", id] as const,
  lines: (orgId: string, id: string, params: object) => ["org", orgId, "royalties", "statements", "lines", id, params] as const,
  reconciliation: (orgId: string, id: string) => ["org", orgId, "royalties", "statements", "reconciliation", id] as const,
  unmatched: (orgId: string, params: object) => ["org", orgId, "royalties", "statements", "unmatched", params] as const,
  anomalies: (orgId: string, statementId: string) => ["org", orgId, "royalties", "statements", "anomalies", statementId] as const,
  runs: (orgId: string) => ["org", orgId, "royalties", "runs"] as const,
  runList: (orgId: string, params: object) => ["org", orgId, "royalties", "runs", "list", params] as const,
  run: (orgId: string, id: string) => ["org", orgId, "royalties", "runs", "detail", id] as const,
  allocations: (orgId: string, id: string, params: object) => ["org", orgId, "royalties", "runs", "allocations", id, params] as const,
  summary: (orgId: string, id: string, groupBy: string) => ["org", orgId, "royalties", "runs", "summary", id, groupBy] as const,
  reportTypes: (orgId: string) => ["org", orgId, "royalties", "reports", "types"] as const,
  report: (orgId: string, type: string, filters: object) => ["org", orgId, "royalties", "reports", "result", type, filters] as const,
  job: (orgId: string, jobId: string) => ["org", orgId, "jobs", jobId] as const,
  recordingSearch: (orgId: string, q: string) => ["org", orgId, "royalties", "search", "recordings", q] as const,
  workSearch: (orgId: string, q: string) => ["org", orgId, "royalties", "search", "works", q] as const,
};

/** Ledger and payout data change when runs are posted or reversed. */
function invalidateFinancials(qc: QueryClient, orgId: string) {
  void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) });
  void qc.invalidateQueries({ queryKey: ["org", orgId, "payouts"] });
  void qc.invalidateQueries({ queryKey: ["org", orgId, "dashboard"] });
}

// --------------------------------------------------------------------------- reference data

/** `/reference/*` lists rarely change; cache them for the session. */
export function useRoyaltyReference(kind: "source-categories" | "rights-types") {
  return useQuery({
    queryKey: ["reference", kind],
    queryFn: ({ signal }) => api.get<ReferenceItem[]>(`/reference/${kind}`, { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

// --------------------------------------------------------------------------- statements

export function useStatements(orgId: string, params: StatementListParams) {
  return useQuery({
    queryKey: royaltyKeys.statementList(orgId, params),
    queryFn: ({ signal }) =>
      api.get<Page<Statement>>(`${royaltiesPath(orgId)}/statements`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    // Keep queued/processing rows fresh without a manual reload.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === "queued" || item.status === "processing") ? 3000 : false,
  });
}

export function useStatement(orgId: string, statementId: string, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: royaltyKeys.statement(orgId, statementId),
    queryFn: ({ signal }) => api.get<Statement>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}`, { signal }),
    enabled: Boolean(statementId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (options.poll === false) return false;
      return status === "queued" || status === "processing" ? 1500 : false;
    },
  });
}

export function useStatementPreview(orgId: string, statementId: string | null) {
  return useQuery({
    queryKey: royaltyKeys.preview(orgId, statementId ?? ""),
    queryFn: ({ signal }) =>
      api.get<StatementPreview>(`${royaltiesPath(orgId)}/statements/${seg(statementId ?? "")}/preview`, { signal }),
    enabled: Boolean(statementId),
    staleTime: 5 * 60_000,
  });
}

export function useUploadStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StatementUploadInput) => {
      const formData = new FormData();
      formData.append("file", input.file);
      formData.append("source_name", input.source_name);
      formData.append("source_category", input.source_category);
      formData.append("period_start", input.period_start);
      formData.append("period_end", input.period_end);
      formData.append("currency", input.currency);
      if (input.default_rights_type) formData.append("default_rights_type", input.default_rights_type);
      if (input.reported_total) formData.append("reported_total", input.reported_total);
      if (input.notes) formData.append("notes", input.notes);
      return api.post<Statement>(`${royaltiesPath(orgId)}/statements`, { formData });
    },
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statement.id), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.statements(orgId) });
    },
  });
}

export interface ManualStatementInput {
  source_name: string;
  source_category: string;
  period_start: string;
  period_end: string;
  currency: string;
  default_rights_type?: string | null;
  reported_total?: string | null;
  notes?: string | null;
  lines: {
    title?: string;
    isrc?: string;
    iswc?: string;
    recording_id?: string;
    work_id?: string;
    territory?: string;
    rights_type?: string;
    usage_type?: string;
    amount: string;
    transaction_date?: string;
    description?: string;
  }[];
}

/** Manual adjustments / licensing income without a file (created as processed). */
export function useCreateManualStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ManualStatementInput) => api.post<Statement>(`${royaltiesPath(orgId)}/statements/manual`, { body }),
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statement.id), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) });
    },
  });
}

export function useUpdateMapping(orgId: string, statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { adapter: string; column_mapping: Record<string, string> }) =>
      api.put<Statement>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/mapping`, { body }),
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statementId), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.preview(orgId, statementId) });
    },
  });
}

export function useProcessStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) =>
      api.post<Statement>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/process`),
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statement.id), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.statements(orgId) });
      void qc.invalidateQueries({ queryKey: royaltyKeys.runs(orgId) });
    },
  });
}

// PATCH semantics: every field is optional (generated type marks defaulted fields required).
export type StatementUpdate = Partial<Schemas["StatementUpdate"]>;

/** Edit statement details (locked once posted; currency only before processing). */
export function useUpdateStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statementId, body }: { statementId: string; body: StatementUpdate }) =>
      api.patch<Statement>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}`, { body }),
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statement.id), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.statements(orgId) });
      void qc.invalidateQueries({ queryKey: royaltyKeys.runs(orgId) });
    },
  });
}

/** Cancel processing that hasn't started yet (status "queued"). */
export function useCancelStatementProcessing(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) => api.post<Statement>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/cancel`),
    onSuccess: (statement) => {
      qc.setQueryData(royaltyKeys.statement(orgId, statement.id), statement);
      void qc.invalidateQueries({ queryKey: royaltyKeys.statements(orgId) });
    },
  });
}

export function useDeleteStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) => api.delete<{ message: string }>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}`),
    onSuccess: (_data, statementId) => {
      qc.removeQueries({ queryKey: royaltyKeys.statement(orgId, statementId) });
      void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) });
    },
  });
}

export function useRematchStatement(orgId: string, statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ newly_matched: number }>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/rematch`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) }),
  });
}

export function downloadStatementFile(orgId: string, statementId: string) {
  return downloadFile(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/download`);
}

// --------------------------------------------------------------------------- lines & matching

export function useStatementLines(orgId: string, statementId: string, params: LineListParams, enabled = true) {
  return useQuery({
    queryKey: royaltyKeys.lines(orgId, statementId, params),
    queryFn: ({ signal }) =>
      api.get<Page<StatementLine>>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/lines`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled: enabled && Boolean(statementId),
  });
}

export function useMatchLine(orgId: string, statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, ...body }: LineMatchInput & { lineId: string }) =>
      api.patch<StatementLine>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/lines/${seg(lineId)}`, { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) }),
  });
}

export function useBulkMatch(orgId: string, statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkMatchInput) =>
      api.post<{ updated: number }>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/lines/bulk-match`, { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) }),
  });
}

export function useReconciliation(orgId: string, statementId: string, enabled = true) {
  return useQuery({
    queryKey: royaltyKeys.reconciliation(orgId, statementId),
    queryFn: ({ signal }) =>
      api.get<Reconciliation>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/reconciliation`, { signal }),
    enabled: enabled && Boolean(statementId),
  });
}

export function useUnmatched(orgId: string, params: { page: number; page_size: number }) {
  return useQuery({
    queryKey: royaltyKeys.unmatched(orgId, params),
    queryFn: ({ signal }) => api.get<Page<UnmatchedGroup>>(`${royaltiesPath(orgId)}/unmatched`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useStatementAnomalies(orgId: string, statementId: string, enabled = true) {
  return useQuery({
    queryKey: royaltyKeys.anomalies(orgId, statementId),
    queryFn: ({ signal }) =>
      api.get<AnomalyReport>(`${orgPath(orgId)}/ai/anomalies`, { query: { statement_id: statementId }, signal }),
    enabled: enabled && Boolean(statementId),
  });
}

export function useClassifyStatement(orgId: string) {
  return useMutation({
    mutationFn: (body: { headers: string[]; sample_rows: (string | null)[][]; filename?: string | null }) =>
      api.post<StatementClassification>(`${orgPath(orgId)}/ai/statements/classify`, { body }),
  });
}

// --------------------------------------------------------------------------- catalog search (matching)

export function useRecordingSearch(orgId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: royaltyKeys.recordingSearch(orgId, q),
    queryFn: ({ signal }) =>
      api.get<Page<RecordingSummary>>(`${orgPath(orgId)}/recordings`, { query: { q: q || undefined, page_size: 10 }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useWorkSearch(orgId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: royaltyKeys.workSearch(orgId, q),
    queryFn: ({ signal }) =>
      api.get<Page<WorkSummary>>(`${orgPath(orgId)}/works`, { query: { q: q || undefined, page_size: 10 }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

// --------------------------------------------------------------------------- runs

export function useCalculateStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) => api.post<Run>(`${royaltiesPath(orgId)}/statements/${seg(statementId)}/calculate`),
    onSuccess: (run) => {
      qc.setQueryData(royaltyKeys.run(orgId, run.id), run);
      void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) });
    },
  });
}

export function useRuns(orgId: string, params: { page: number; page_size: number; status?: string; statement_id?: string; sort?: string; order?: "asc" | "desc" }) {
  return useQuery({
    queryKey: royaltyKeys.runList(orgId, params),
    queryFn: ({ signal }) => api.get<Page<Run>>(`${royaltiesPath(orgId)}/runs`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useRun(orgId: string, runId: string) {
  return useQuery({
    queryKey: royaltyKeys.run(orgId, runId),
    queryFn: ({ signal }) => api.get<Run>(`${royaltiesPath(orgId)}/runs/${seg(runId)}`, { signal }),
    enabled: Boolean(runId),
  });
}

export function useAllocations(orgId: string, runId: string, params: AllocationListParams) {
  return useQuery({
    queryKey: royaltyKeys.allocations(orgId, runId, params),
    queryFn: ({ signal }) =>
      api.get<Page<Allocation>>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/allocations`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled: Boolean(runId),
  });
}

export type SummaryGroupBy = "party" | "reason" | "rights_type";

export function useRunSummary(orgId: string, runId: string, groupBy: SummaryGroupBy) {
  return useQuery({
    queryKey: royaltyKeys.summary(orgId, runId, groupBy),
    queryFn: ({ signal }) =>
      api.get<RunSummaryRow[]>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/summary`, { query: { group_by: groupBy }, signal }),
    enabled: Boolean(runId),
  });
}

export function useVerifyRun(orgId: string) {
  return useMutation({
    mutationFn: (runId: string) => api.post<VerifyResult>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/verify`),
  });
}

export function usePostRun(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post<Run>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/post`),
    onSuccess: (run) => {
      qc.setQueryData(royaltyKeys.run(orgId, run.id), run);
      invalidateFinancials(qc, orgId);
    },
  });
}

export function useReverseRun(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      api.post<Run>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/reverse`, { body: { reason } }),
    onSuccess: (run) => {
      qc.setQueryData(royaltyKeys.run(orgId, run.id), run);
      invalidateFinancials(qc, orgId);
    },
  });
}

export function useDiscardRun(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post<Run>(`${royaltiesPath(orgId)}/runs/${seg(runId)}/discard`),
    onSuccess: (run) => {
      qc.setQueryData(royaltyKeys.run(orgId, run.id), run);
      void qc.invalidateQueries({ queryKey: royaltyKeys.all(orgId) });
    },
  });
}

// --------------------------------------------------------------------------- reports

export function useReportTypes(orgId: string) {
  return useQuery({
    queryKey: royaltyKeys.reportTypes(orgId),
    queryFn: ({ signal }) => api.get<Record<string, string>>(`${royaltiesPath(orgId)}/reports/types`, { signal }),
    staleTime: Infinity,
  });
}

export function useReport(orgId: string, reportType: string | null, filters: ReportFilters) {
  return useQuery({
    queryKey: royaltyKeys.report(orgId, reportType ?? "", filters),
    queryFn: ({ signal }) =>
      api.get<ReportResult>(`${royaltiesPath(orgId)}/reports/${seg(reportType ?? "")}`, { query: { ...filters, limit: 500 }, signal }),
    enabled: Boolean(reportType),
    placeholderData: keepPreviousData,
  });
}

export function useExportReport(orgId: string) {
  return useMutation({
    mutationFn: ({ reportType, filters }: { reportType: string; filters: ReportFilters }) =>
      api.post<{ job_id: string; status: string }>(`${royaltiesPath(orgId)}/reports/${seg(reportType)}/export`, { query: { ...filters } }),
  });
}

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** Polls a background job until it reaches a terminal state. */
export function useJob(orgId: string, jobId: string | null) {
  return useQuery({
    queryKey: royaltyKeys.job(orgId, jobId ?? ""),
    queryFn: ({ signal }) => api.get<Job>(`${orgPath(orgId)}/jobs/${seg(jobId ?? "")}`, { signal }),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data && TERMINAL_JOB_STATUSES.has(query.state.data.status) ? false : 1500),
  });
}

export function downloadReportExport(orgId: string, jobId: string) {
  return downloadFile(`${royaltiesPath(orgId)}/reports/exports/${seg(jobId)}/download`);
}

/**
 * Polls a background job until it finishes. Resolves with the succeeded job;
 * rejects when it fails, is cancelled or exceeds `timeoutMs`.
 */
export async function waitForJob(orgId: string, jobId: string, onProgress?: (job: Job) => void, timeoutMs = 5 * 60_000): Promise<Job> {
  const started = Date.now();
  for (;;) {
    const job = await api.get<Job>(`${orgPath(orgId)}/jobs/${seg(jobId)}`);
    onProgress?.(job);
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error || `The export job ${job.status}.`);
    if (Date.now() - started > timeoutMs) throw new Error("The export is taking longer than expected. Try again later.");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}
