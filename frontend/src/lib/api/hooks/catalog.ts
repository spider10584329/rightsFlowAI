"use client";

/**
 * Catalog hooks: parties, works, recordings, releases and catalog tooling
 * (bulk actions, validation issues, duplicates, completeness, summary,
 * activity, imports and exports).
 *
 * Types mirror `backend/app/schemas/catalog.py`. Every key lives under
 * `["org", orgId, "catalog", ...]`, so a mutation invalidates the whole
 * catalog subtree (lists, details, summary, completeness, issues).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, downloadFile, type QueryParams } from "@/lib/api/client";
import type { MessageResponse, Page } from "@/lib/api/types";

// ----------------------------------------------------------------- vocabularies

export type CatalogEntityType = "work" | "recording" | "release" | "party";
export type CatalogStatus = "active" | "draft" | "archived";
export type CreateStatus = "active" | "draft";
export type VerificationStatus = "unverified" | "verified" | "disputed";
export type PartyType = "person" | "company";
export type PartyRole =
  | "artist"
  | "songwriter"
  | "composer"
  | "lyricist"
  | "producer"
  | "publisher"
  | "label"
  | "performer"
  | "engineer"
  | "administrator"
  | "other";
export type WorkContributorRole =
  | "composer"
  | "lyricist"
  | "composer_lyricist"
  | "arranger"
  | "adapter"
  | "translator"
  | "original_publisher"
  | "sub_publisher"
  | "administrator";
export type RecordingContributorRole =
  | "main_artist"
  | "featured_artist"
  | "producer"
  | "co_producer"
  | "mixer"
  | "engineer"
  | "mastering_engineer"
  | "musician"
  | "vocalist"
  | "label";
export type ReleaseType = "album" | "ep" | "single" | "compilation" | "other";
export type ImportEntityType = "work" | "recording" | "party";

export const PARTY_ROLES: readonly PartyRole[] = [
  "artist",
  "songwriter",
  "composer",
  "lyricist",
  "producer",
  "publisher",
  "label",
  "performer",
  "engineer",
  "administrator",
  "other",
];
export const WORK_CONTRIBUTOR_ROLES: readonly WorkContributorRole[] = [
  "composer",
  "lyricist",
  "composer_lyricist",
  "arranger",
  "adapter",
  "translator",
  "original_publisher",
  "sub_publisher",
  "administrator",
];
export const RECORDING_CONTRIBUTOR_ROLES: readonly RecordingContributorRole[] = [
  "main_artist",
  "featured_artist",
  "producer",
  "co_producer",
  "mixer",
  "engineer",
  "mastering_engineer",
  "musician",
  "vocalist",
  "label",
];
export const RELEASE_TYPES: readonly ReleaseType[] = ["album", "ep", "single", "compilation", "other"];

// ----------------------------------------------------------------- shared shapes

export interface Completeness {
  score: number;
  missing: string[];
}

type ExternalIds = Record<string, unknown> | null;
/** Editable external identifiers (e.g. DSP ids, society work numbers). */
export type ExternalIdsInput = Record<string, string> | null;

// ----------------------------------------------------------------- parties

export interface Party {
  id: string;
  organization_id: string;
  name: string;
  party_type: PartyType | string;
  roles: string[];
  legal_name: string | null;
  email: string | null;
  country_code: string | null;
  ipi_number: string | null;
  isni: string | null;
  pro_affiliation: string | null;
  is_internal: boolean;
  external_ids: ExternalIds;
  notes: string | null;
  status: CatalogStatus | string;
  created_at: string;
  updated_at: string;
}

export interface PartyDetail extends Party {
  work_count: number;
  recording_count: number;
  release_count: number;
  references: Record<string, number>;
  is_referenced: boolean;
}

export interface PartyInput {
  name: string;
  external_ids?: ExternalIdsInput;
  party_type: PartyType;
  roles: PartyRole[];
  legal_name: string | null;
  email: string | null;
  country_code: string | null;
  ipi_number: string | null;
  isni: string | null;
  pro_affiliation: string | null;
  is_internal: boolean;
  notes: string | null;
  status: CatalogStatus;
}

// ----------------------------------------------------------------- works

export interface WorkContributor {
  id: string;
  party_id: string;
  party_name: string | null;
  role: string;
}

export interface LinkedRecording {
  id: string;
  title: string;
  version_title: string | null;
  isrc: string | null;
  artist: string | null;
  status: string;
}

export interface Work {
  id: string;
  organization_id: string;
  title: string;
  alternate_titles: string[] | null;
  iswc: string | null;
  iswc_display: string | null;
  internal_code: string | null;
  language: string | null;
  genre: string | null;
  creation_year: number | null;
  lyrics_excerpt: string | null;
  external_ids: ExternalIds;
  notes: string | null;
  status: CatalogStatus | string;
  verification_status: VerificationStatus | string;
  contributors: WorkContributor[];
  completeness: Completeness;
  created_at: string;
  updated_at: string;
}

export interface WorkDetail extends Work {
  recordings: LinkedRecording[];
}

export interface WorkInput {
  title: string;
  external_ids?: ExternalIdsInput;
  alternate_titles: string[] | null;
  iswc: string | null;
  internal_code: string | null;
  language: string | null;
  genre: string | null;
  creation_year: number | null;
  lyrics_excerpt: string | null;
  notes: string | null;
  status: CatalogStatus;
  verification_status: VerificationStatus;
  contributors: { party_id: string; role: WorkContributorRole }[];
}

// ----------------------------------------------------------------- recordings

export interface RecordingContributor {
  id: string;
  party_id: string;
  party_name: string | null;
  role: string;
  instrument: string | null;
}

export interface LinkedWork {
  id: string;
  title: string;
  iswc: string | null;
  status: string;
}

export interface RecordingReleaseRef {
  id: string;
  title: string;
  upc: string | null;
  disc_number: number;
  track_number: number;
  status: string;
}

export interface Recording {
  id: string;
  organization_id: string;
  title: string;
  version_title: string | null;
  isrc: string | null;
  internal_code: string | null;
  primary_artist_id: string | null;
  primary_artist_name: string | null;
  display_artist: string | null;
  artist: string | null;
  duration_seconds: number | null;
  recording_date: string | null;
  p_line: string | null;
  is_explicit: boolean;
  external_ids: ExternalIds;
  notes: string | null;
  status: CatalogStatus | string;
  verification_status: VerificationStatus | string;
  contributors: RecordingContributor[];
  works: LinkedWork[];
  completeness: Completeness;
  created_at: string;
  updated_at: string;
}

export interface RecordingDetail extends Recording {
  releases: RecordingReleaseRef[];
}

export interface RecordingInput {
  title: string;
  external_ids?: ExternalIdsInput;
  version_title: string | null;
  isrc: string | null;
  internal_code: string | null;
  primary_artist_id: string | null;
  display_artist: string | null;
  duration_seconds: number | null;
  recording_date: string | null;
  p_line: string | null;
  is_explicit: boolean;
  notes: string | null;
  status: CatalogStatus;
  verification_status: VerificationStatus;
  contributors: { party_id: string; role: RecordingContributorRole; instrument: string | null }[];
  work_ids: string[];
}

// ----------------------------------------------------------------- releases

export interface ReleaseTrack {
  id: string;
  recording_id: string;
  recording_title: string | null;
  version_title: string | null;
  isrc: string | null;
  artist: string | null;
  duration_seconds: number | null;
  disc_number: number;
  track_number: number;
}

export interface Release {
  id: string;
  organization_id: string;
  title: string;
  release_type: ReleaseType | string;
  upc: string | null;
  catalog_number: string | null;
  label_id: string | null;
  label_name: string | null;
  display_artist: string | null;
  release_date: string | null;
  c_line: string | null;
  external_ids: ExternalIds;
  notes: string | null;
  status: CatalogStatus | string;
  tracks: ReleaseTrack[];
  track_count: number;
  completeness: Completeness;
  created_at: string;
  updated_at: string;
}

export interface ReleaseInput {
  title: string;
  external_ids?: ExternalIdsInput;
  release_type: ReleaseType;
  upc: string | null;
  catalog_number: string | null;
  label_id: string | null;
  display_artist: string | null;
  release_date: string | null;
  c_line: string | null;
  notes: string | null;
  status: CatalogStatus;
  tracks: { recording_id: string; disc_number: number; track_number: number }[];
}

// ----------------------------------------------------------------- tooling

export interface BulkSkipped {
  id: string;
  reason: string;
}

export interface CatalogBulkResult {
  entity_type: CatalogEntityType;
  action: BulkAction;
  affected: number;
  affected_ids: string[];
  skipped: BulkSkipped[];
}

export type BulkAction = "archive" | "restore" | "delete";
export type IssueSeverity = "error" | "warning" | "info";

export interface CatalogValidationIssue {
  entity_type: CatalogEntityType;
  entity_id: string;
  title: string;
  code: string;
  severity: IssueSeverity;
  message: string;
}

export interface ValidationIssuesPage extends Page<CatalogValidationIssue> {
  by_code: Record<string, number>;
}

export interface DuplicateCandidate {
  entity_type: CatalogEntityType;
  ids: string[];
  titles: string[];
  score: number;
  reasons: string[];
}

export interface CompletenessItem {
  entity_type: CatalogEntityType;
  id: string;
  title: string;
  score: number;
  missing: string[];
}

export interface CompletenessSummary {
  count: number;
  average_score: number;
  bands: Record<string, number>;
  by_entity_type: Record<string, { count: number; average_score: number }>;
  least_complete: CompletenessItem[];
}

export interface RecentItem {
  entity_type: CatalogEntityType;
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export interface CatalogSummary {
  works: number;
  recordings: number;
  releases: number;
  parties: number;
  archived: Record<string, number>;
  parties_by_role: Record<string, number>;
  missing_identifiers: Record<string, number>;
  recently_updated: RecentItem[];
}

export interface CatalogActivity {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  changes: Record<string, unknown> | null;
  created_at: string;
}

export type ImportJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportResult {
  entity_type: ImportEntityType;
  dry_run: boolean;
  filename: string;
  total_rows: number;
  created: number;
  updated: number;
  skipped: number;
  parties_created: number;
  error_count: number;
  errors: ImportRowError[];
  errors_truncated: boolean;
  ignored_columns: string[];
  file_id?: string;
}

export interface ImportJob {
  id: string;
  job_type: string;
  status: ImportJobStatus | string;
  progress: number;
  entity_type: ImportEntityType | null;
  dry_run: boolean;
  filename: string | null;
  file_id: string | null;
  result: Partial<ImportResult> | null;
  error: string | null;
  deduplicated: boolean;
  created_by_id: string | null;
  created_at: string;
  finished_at: string | null;
}

// ----------------------------------------------------------------- entity map

export interface CatalogEntityMap {
  work: { item: Work; detail: WorkDetail; input: WorkInput };
  recording: { item: Recording; detail: RecordingDetail; input: RecordingInput };
  release: { item: Release; detail: Release; input: ReleaseInput };
  party: { item: Party; detail: PartyDetail; input: PartyInput };
}

export type CatalogItem<E extends CatalogEntityType> = CatalogEntityMap[E]["item"];
export type CatalogDetail<E extends CatalogEntityType> = CatalogEntityMap[E]["detail"];
export type CatalogInput<E extends CatalogEntityType> = CatalogEntityMap[E]["input"];

/** URL segment used by both the backend collection and the frontend route. */
export const ENTITY_SEGMENT: Record<CatalogEntityType, string> = {
  work: "works",
  recording: "recordings",
  release: "releases",
  party: "parties",
};

const orgPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;
const collectionPath = (orgId: string, entity: CatalogEntityType) => `${orgPath(orgId)}/${ENTITY_SEGMENT[entity]}`;
const itemPath = (orgId: string, entity: CatalogEntityType, id: string) => `${collectionPath(orgId, entity)}/${encodeURIComponent(id)}`;

export const catalogKeys = {
  all: (orgId: string) => ["org", orgId, "catalog"] as const,
  list: (orgId: string, entity: CatalogEntityType, params: QueryParams) => ["org", orgId, "catalog", entity, "list", params] as const,
  detail: (orgId: string, entity: CatalogEntityType, id: string) => ["org", orgId, "catalog", entity, "detail", id] as const,
  activity: (orgId: string, entity: CatalogEntityType, id: string, params: QueryParams) =>
    ["org", orgId, "catalog", entity, "activity", id, params] as const,
  summary: (orgId: string) => ["org", orgId, "catalog", "summary"] as const,
  completeness: (orgId: string, entity: string | null) => ["org", orgId, "catalog", "completeness", entity] as const,
  issues: (orgId: string, params: QueryParams) => ["org", orgId, "catalog", "issues", params] as const,
  duplicates: (orgId: string, entity: CatalogEntityType, limit: number) => ["org", orgId, "catalog", "duplicates", entity, limit] as const,
  imports: (orgId: string) => ["org", orgId, "catalog", "imports"] as const,
  importJob: (orgId: string, jobId: string) => ["org", orgId, "catalog", "imports", jobId] as const,
};

// ----------------------------------------------------------------- lists & details

export interface CatalogListParams extends QueryParams {
  page?: number;
  page_size?: number;
  sort?: string;
  order?: "asc" | "desc";
  q?: string;
  status?: string;
}

export function useCatalogList<E extends CatalogEntityType>(
  orgId: string,
  entity: E,
  params: CatalogListParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: catalogKeys.list(orgId, entity, params),
    queryFn: ({ signal }) => api.get<Page<CatalogItem<E>>>(collectionPath(orgId, entity), { query: params, signal }),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useCatalogDetail<E extends CatalogEntityType>(orgId: string, entity: E, id: string) {
  return useQuery({
    queryKey: catalogKeys.detail(orgId, entity, id),
    queryFn: ({ signal }) => api.get<CatalogDetail<E>>(itemPath(orgId, entity, id), { signal }),
    enabled: Boolean(id),
    retry: (count, error) => !(error && typeof error === "object" && "status" in error && error.status === 404) && count < 2,
  });
}

export function useCreateCatalogItem<E extends CatalogEntityType>(orgId: string, entity: E) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, allowDuplicate }: { body: CatalogInput<E>; allowDuplicate?: boolean }) =>
      api.post<CatalogDetail<E>>(collectionPath(orgId, entity), {
        body,
        query: entity !== "party" && allowDuplicate ? { allow_duplicate: true } : undefined,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: catalogKeys.all(orgId) }),
  });
}

export function useUpdateCatalogItem<E extends CatalogEntityType>(orgId: string, entity: E) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, allowDuplicate }: { id: string; body: Partial<CatalogInput<E>>; allowDuplicate?: boolean }) =>
      api.patch<CatalogDetail<E>>(itemPath(orgId, entity, id), {
        body,
        query: entity !== "party" && allowDuplicate ? { allow_duplicate: true } : undefined,
      }),
    onSuccess: (data, { id }) => {
      queryClient.setQueryData(catalogKeys.detail(orgId, entity, id), data);
      return queryClient.invalidateQueries({ queryKey: catalogKeys.all(orgId) });
    },
  });
}

export function useDeleteCatalogItem(orgId: string, entity: CatalogEntityType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<MessageResponse>(itemPath(orgId, entity, id)),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: catalogKeys.detail(orgId, entity, id) });
      return queryClient.invalidateQueries({ queryKey: catalogKeys.all(orgId) });
    },
  });
}

export function useCatalogBulk(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { entity_type: CatalogEntityType; action: BulkAction; ids: string[] }) =>
      api.post<CatalogBulkResult>(`${orgPath(orgId)}/catalog/bulk`, { body: payload }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: catalogKeys.all(orgId) }),
  });
}

// ----------------------------------------------------------------- tooling

export function useCatalogSummary(orgId: string) {
  return useQuery({
    queryKey: catalogKeys.summary(orgId),
    queryFn: ({ signal }) => api.get<CatalogSummary>(`${orgPath(orgId)}/catalog/summary`, { signal }),
  });
}

export function useCatalogCompleteness(orgId: string, entity: Exclude<CatalogEntityType, "party"> | null = null) {
  return useQuery({
    queryKey: catalogKeys.completeness(orgId, entity),
    queryFn: ({ signal }) =>
      api.get<CompletenessSummary>(`${orgPath(orgId)}/catalog/completeness`, { query: { entity_type: entity }, signal }),
  });
}

export interface IssueParams extends QueryParams {
  entity_type?: CatalogEntityType;
  severity?: IssueSeverity;
  code?: string;
  page?: number;
  page_size?: number;
}

export function useValidationIssues(orgId: string, params: IssueParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: catalogKeys.issues(orgId, params),
    queryFn: ({ signal }) => api.get<ValidationIssuesPage>(`${orgPath(orgId)}/catalog/validation-issues`, { query: params, signal }),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useDuplicates(orgId: string, entity: CatalogEntityType, limit = 50) {
  return useQuery({
    queryKey: catalogKeys.duplicates(orgId, entity, limit),
    queryFn: ({ signal }) =>
      api.get<DuplicateCandidate[]>(`${orgPath(orgId)}/catalog/duplicates`, { query: { entity_type: entity, limit }, signal }),
  });
}

export function useEntityActivity(orgId: string, entity: CatalogEntityType, id: string, params: { page: number; page_size: number }) {
  return useQuery({
    queryKey: catalogKeys.activity(orgId, entity, id, params),
    queryFn: ({ signal }) =>
      api.get<Page<CatalogActivity>>(`${orgPath(orgId)}/catalog/${entity}/${encodeURIComponent(id)}/activity`, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

// ----------------------------------------------------------------- imports & exports

export function isImportFinished(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function useImportJobs(orgId: string, limit = 50) {
  return useQuery({
    queryKey: [...catalogKeys.imports(orgId), "list", limit] as const,
    queryFn: ({ signal }) => api.get<ImportJob[]>(`${orgPath(orgId)}/catalog/imports`, { query: { limit }, signal }),
    // Keep the history fresh while any job is still running.
    refetchInterval: (query) => (query.state.data?.some((job) => !isImportFinished(job.status)) ? 3000 : false),
  });
}

export function useImportJob(orgId: string, jobId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: catalogKeys.importJob(orgId, jobId ?? ""),
    queryFn: async ({ signal }) => {
      const job = await api.get<ImportJob>(`${orgPath(orgId)}/catalog/imports/${encodeURIComponent(jobId ?? "")}`, { signal });
      if (isImportFinished(job.status) && !job.dry_run) {
        // A finished real import changed catalog data: refresh lists and stats.
        void queryClient.invalidateQueries({
          queryKey: catalogKeys.all(orgId),
          predicate: (query) => query.queryKey[3] !== "imports",
        });
      }
      return job;
    },
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data && isImportFinished(query.state.data.status) ? false : 1000),
  });
}

export function useStartImport(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, entityType, dryRun }: { file: File; entityType: ImportEntityType; dryRun: boolean }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("entity_type", entityType);
      formData.append("dry_run", dryRun ? "true" : "false");
      return api.post<ImportJob>(`${orgPath(orgId)}/catalog/imports`, { formData });
    },
    onSuccess: (job) => {
      queryClient.setQueryData(catalogKeys.importJob(orgId, job.id), job);
      return queryClient.invalidateQueries({ queryKey: catalogKeys.imports(orgId) });
    },
  });
}

export function downloadImportTemplate(orgId: string, entityType: ImportEntityType): Promise<void> {
  return downloadFile(`${orgPath(orgId)}/catalog/imports/template`, undefined, { query: { entity_type: entityType } });
}

export function downloadCatalogExport(orgId: string, entityType: CatalogEntityType, includeArchived = false): Promise<void> {
  return downloadFile(`${orgPath(orgId)}/catalog/export`, undefined, {
    query: { entity_type: entityType, include_archived: includeArchived || undefined },
  });
}

// ----------------------------------------------------------------- merge duplicates

export interface MergeResult {
  entity_type: CatalogEntityType;
  survivor_id: string;
  duplicate_id: string;
  moved: Record<string, number>;
  filled_fields: string[];
  message: string;
}

/** Admin: fold `duplicate_id` into `survivor_id` (duplicate is archived, never deleted). */
export function useMergeCatalogItems(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { entity_type: CatalogEntityType; survivor_id: string; duplicate_id: string }) =>
      api.post<MergeResult>(`${orgPath(orgId)}/catalog/merge`, { body: { ...body, confirm: true } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all(orgId) });
      void queryClient.invalidateQueries({ queryKey: ["org", orgId, "rights"] });
    },
  });
}
