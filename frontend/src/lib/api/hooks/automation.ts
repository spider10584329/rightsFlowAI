"use client";

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { royaltyKeys } from "@/lib/api/hooks/royalties";
import { queryKeys } from "@/lib/api/query-keys";
import type { Schemas } from "@/lib/api/types";

// ----------------------------------------------------------------- types
// Credentials use the generated `CredentialResponse` schema. The other
// endpoints return untyped dicts (`unknown` in schema.d.ts), so their shapes
// mirror the payload helpers in backend/app/services/automation/* by hand.

export type CredentialState = Schemas["CredentialResponse"]["state"];
/** ok | warning | critical | expired | revoked, computed by the backend from `expires_at`. */
export type CredentialExpiryLevel = Schemas["CredentialResponse"]["expiry_level"];
export type IncidentStatus = "open" | "resolved";
export type StatementAutomationState =
  | "pending"
  | "processing"
  | "completed"
  | "retry_waiting"
  | "failed"
  | "needs_manual_review"
  | "awaiting_mapping";
export type InboxFileState = "imported" | "duplicate" | "rejected";
export type AutomationRunStatus = "running" | "succeeded" | "failed" | "partial" | "skipped";
export type AutomationEventStatus = "pending" | "claimed" | "completed" | "failed" | "dead";
export type ReviewTaskStatus = "open" | "resolved" | "dismissed";
export type ReviewTaskKind = "statement_review" | "statement_mapping" | "ai_metadata" | "ai_conflict";
export type ReviewSubjectType = "work" | "recording" | "party" | "rights_conflict";

export const RUN_STATUSES: AutomationRunStatus[] = ["running", "succeeded", "failed", "partial", "skipped"];
export const EVENT_STATUSES: AutomationEventStatus[] = ["pending", "claimed", "completed", "failed", "dead"];
export const REVIEW_TASK_STATUSES: ReviewTaskStatus[] = ["open", "resolved", "dismissed"];
export const REVIEW_TASK_KINDS: ReviewTaskKind[] = ["statement_review", "statement_mapping", "ai_metadata", "ai_conflict"];
/** Grace periods offered when rotating a key (backend allows 0..168). */
export const ROTATION_GRACE_HOURS = [0, 24, 72, 168] as const;
export const DEFAULT_KEY_LIFETIME_DAYS = 90;
export const MAX_KEY_LIFETIME_DAYS = 365;
export const INCIDENT_STATUSES: IncidentStatus[] = ["open", "resolved"];
export const STATEMENT_AUTOMATION_STATES: StatementAutomationState[] = [
  "needs_manual_review",
  "failed",
  "retry_waiting",
  "awaiting_mapping",
  "pending",
  "processing",
  "completed",
];
/** States a person may need to act on; everything except `completed`. */
export const ATTENTION_STATEMENT_STATES: StatementAutomationState[] = [
  "needs_manual_review",
  "failed",
  "retry_waiting",
  "awaiting_mapping",
  "pending",
  "processing",
];
export const INBOX_FILE_STATES: InboxFileState[] = ["imported", "duplicate", "rejected"];

export interface AutomationScope {
  scope: string;
  description: string;
}

/** Never contains the key itself: only a hint (`rfa_<key_id>_…`). */
export type AutomationCredential = Schemas["CredentialResponse"];

/** Create/rotate response. `token` is shown once: never cache or persist it. */
export interface IssuedAutomationCredential {
  credential: AutomationCredential;
  token: string;
}

export interface CredentialCreateInput {
  name: string;
  scopes?: string[];
  expires_in_days?: number;
}

export interface AutomationOverview {
  active_credentials: number;
  /** Non-revoked keys at the `warning` or `critical` expiry level. */
  expiring_credentials?: number;
  open_incidents?: number;
  /** False when no non-revoked key has the `events:consume` scope, so no events are queued. */
  automation_enabled?: boolean;
  outbox: {
    pending: number;
    claimed: number;
    completed: number;
    dead: number;
    oldest_pending_seconds: number | null;
  };
  failed_runs_24h: number;
  open_review_tasks: number;
}

export interface AutomationRun {
  id: string;
  workflow: string;
  execution_id: string | null;
  trigger_type: string;
  status: AutomationRunStatus;
  idempotency_key?: string | null;
  correlation_id: string | null;
  event_id?: string | null;
  retry_count: number;
  summary: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AutomationEvent {
  id: string;
  event_type: string;
  payload?: Record<string, unknown> | null;
  status: AutomationEventStatus;
  attempts: number;
  max_attempts: number;
  available_at?: string | null;
  created_at: string;
  completed_at: string | null;
  last_error: string | null;
  correlation_id?: string | null;
}

export interface ReviewTask {
  id: string;
  kind: ReviewTaskKind | (string & {});
  status: ReviewTaskStatus;
  title: string;
  subject_type: string | null;
  subject_id: string | null;
  /** App path, e.g. `/royalties/statements/{id}`. */
  link: string | null;
  details: Record<string, unknown> | null;
  ai_suggestion_id?: string | null;
  run_id?: string | null;
  resolved_by_id?: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRequestResult {
  event_id: string | null;
  subject_type: ReviewSubjectType;
  subject_id: string;
}

/** backend/app/services/automation/incidents.py `incident_payload`. */
export interface AutomationIncident {
  id: string;
  fingerprint?: string | null;
  workflow: string;
  category: string;
  resource: string | null;
  status: IncidentStatus;
  title: string;
  last_error: string | null;
  last_execution_id: string | null;
  occurrences: number;
  alerts_sent: number;
  suppressed: number;
  escalated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_alerted_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

/** backend/app/services/automation/statement_flow.py `state_payload` plus the statement's name and status. */
export interface StatementAutomationRecord {
  statement_id: string;
  /** `inbox` (uploaded by automation) or `app` (uploaded by a person). */
  source: string;
  state: StatementAutomationState | (string & {});
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  error_category: string | null;
  last_error: string | null;
  updated_at: string | null;
  source_name?: string | null;
  statement_status?: string | null;
}

/** backend/app/services/automation/statement_flow.py `inbox_payload`. `sha256` is a 16-character prefix. */
export interface InboxFileOutcome {
  sha256: string;
  file_name: string;
  state: InboxFileState | (string & {});
  statement_id: string | null;
  error_code: string | null;
  error_message?: string | null;
  times_seen: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface IncidentListParams {
  status?: IncidentStatus;
  limit?: number;
}

export interface StatementStateListParams {
  state?: StatementAutomationState;
  limit?: number;
}

export interface InboxFileListParams {
  state?: InboxFileState;
  limit?: number;
}

export interface RunListParams {
  status?: AutomationRunStatus;
  workflow?: string;
  limit?: number;
}

export interface EventListParams {
  status?: AutomationEventStatus;
  limit?: number;
}

export interface ReviewTaskListParams {
  status?: ReviewTaskStatus;
  kind?: ReviewTaskKind;
  limit?: number;
}

// ----------------------------------------------------------------- keys

export const automationKeys = {
  all: (orgId: string) => queryKeys.automation(orgId),
  scopes: (orgId: string) => [...queryKeys.automation(orgId), "scopes"] as const,
  credentials: (orgId: string) => [...queryKeys.automation(orgId), "credentials"] as const,
  overview: (orgId: string) => [...queryKeys.automation(orgId), "overview"] as const,
  runs: (orgId: string, params: RunListParams) => [...queryKeys.automation(orgId), "runs", params] as const,
  events: (orgId: string, params: EventListParams) => [...queryKeys.automation(orgId), "events", params] as const,
  reviewTasksRoot: (orgId: string) => [...queryKeys.automation(orgId), "review-tasks"] as const,
  reviewTasks: (orgId: string, params: ReviewTaskListParams) => [...queryKeys.automation(orgId), "review-tasks", params] as const,
  incidentsRoot: (orgId: string) => [...queryKeys.automation(orgId), "incidents"] as const,
  incidents: (orgId: string, params: IncidentListParams) => [...queryKeys.automation(orgId), "incidents", params] as const,
  statementsRoot: (orgId: string) => [...queryKeys.automation(orgId), "statements"] as const,
  statements: (orgId: string, params: StatementStateListParams) => [...queryKeys.automation(orgId), "statements", params] as const,
  inboxFiles: (orgId: string, params: InboxFileListParams) => [...queryKeys.automation(orgId), "inbox-files", params] as const,
};

const root = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}/automation`;

interface AdminQueryOptions {
  /** Admin-only endpoints: pass false for lower roles so no 403 is requested. */
  enabled?: boolean;
}

// ----------------------------------------------------------------- credentials (admin)

export function useAutomationScopes(orgId: string, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.scopes(orgId),
    queryFn: ({ signal }) => api.get<AutomationScope[]>(`${root(orgId)}/scopes`, { signal }),
    staleTime: 10 * 60_000,
    enabled,
  });
}

export function useAutomationCredentials(orgId: string, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.credentials(orgId),
    queryFn: ({ signal }) => api.get<AutomationCredential[]>(`${root(orgId)}/credentials`, { signal }),
    enabled,
  });
}

/**
 * Create/rotate return the plaintext key exactly once. The result is never
 * written to the query cache and `gcTime: 0` drops the mutation (and its
 * `data`) as soon as the dialog that issued it unmounts or calls `reset()`.
 */
export function useCreateAutomationCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CredentialCreateInput) => api.post<IssuedAutomationCredential>(`${root(orgId)}/credentials`, { body: input }),
    gcTime: 0,
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}

export function useRotateAutomationCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ credentialId, graceHours }: { credentialId: string; graceHours: number }) =>
      api.post<IssuedAutomationCredential>(`${root(orgId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, {
        body: { grace_hours: graceHours },
      }),
    gcTime: 0,
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}

export function useRevokeAutomationCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ credentialId, reason }: { credentialId: string; reason?: string | null }) =>
      api.post<AutomationCredential>(`${root(orgId)}/credentials/${encodeURIComponent(credentialId)}/revoke`, {
        body: { reason: reason?.trim() ? reason.trim() : null },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}

/**
 * Forget the n8n instance a key is bound to, so the next instance that uses the
 * key binds instead. Only for when the old instance is gone (data folder reset or moved).
 */
export function useReleaseAutomationInstance(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) =>
      api.post<AutomationCredential>(`${root(orgId)}/credentials/${encodeURIComponent(credentialId)}/release-instance`),
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.credentials(orgId) }),
  });
}

// ----------------------------------------------------------------- health (admin)

export function useAutomationOverview(orgId: string, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.overview(orgId),
    queryFn: ({ signal }) => api.get<AutomationOverview>(`${root(orgId)}/overview`, { signal }),
    enabled,
  });
}

export function useAutomationRuns(orgId: string, params: RunListParams, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.runs(orgId, params),
    queryFn: ({ signal }) => api.get<AutomationRun[]>(`${root(orgId)}/runs`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAutomationEvents(orgId: string, params: EventListParams, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.events(orgId, params),
    queryFn: ({ signal }) => api.get<AutomationEvent[]>(`${root(orgId)}/events`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Dead-letter recovery: puts a dead event back in the queue. */
export function useRequeueAutomationEvent(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => api.post<AutomationEvent>(`${root(orgId)}/events/${encodeURIComponent(eventId)}/requeue`),
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}

// ----------------------------------------------------------------- incidents (admin)

export function useAutomationIncidents(orgId: string, params: IncidentListParams, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.incidents(orgId, params),
    queryFn: ({ signal }) => api.get<AutomationIncident[]>(`${root(orgId)}/incidents`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Close an incident by hand (e.g. the workflow was retired). A new failure opens a new incident. */
export function useResolveAutomationIncident(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ incidentId, note }: { incidentId: string; note?: string | null }) =>
      api.post<AutomationIncident>(`${root(orgId)}/incidents/${encodeURIComponent(incidentId)}/resolve`, {
        body: { note: note?.trim() ? note.trim() : null },
      }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: automationKeys.incidentsRoot(orgId) }),
        qc.invalidateQueries({ queryKey: automationKeys.overview(orgId) }),
      ]),
  });
}

// ----------------------------------------------------------------- statement processing (viewer / manager)

function fetchStatementStates(orgId: string, params: StatementStateListParams, signal?: AbortSignal) {
  return api.get<StatementAutomationRecord[]>(`${root(orgId)}/statements`, { query: { ...params }, signal });
}

export function useAutomationStatements(orgId: string, params: StatementStateListParams, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.statements(orgId, params),
    queryFn: ({ signal }) => fetchStatementStates(orgId, params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

function byUpdatedDesc(a: StatementAutomationRecord, b: StatementAutomationRecord): number {
  return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

/**
 * Every statement that is not `completed`. The backend filters by one state
 * at a time, so this queries each attention state separately; an unfiltered
 * list would let recent completed statements push older failures out of the limit.
 */
export function useStatementsNeedingAttention(orgId: string, { enabled = true, limit = 100 }: AdminQueryOptions & { limit?: number } = {}) {
  return useQueries({
    queries: ATTENTION_STATEMENT_STATES.map((state) => ({
      queryKey: automationKeys.statements(orgId, { state, limit }),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchStatementStates(orgId, { state, limit }, signal),
      enabled,
    })),
    combine: (results) => {
      const loaded = results.filter((result) => result.data !== undefined);
      return {
        data: loaded.length > 0 ? loaded.flatMap((result) => result.data ?? []).sort(byUpdatedDesc) : undefined,
        isLoading: results.some((result) => result.isLoading),
        isFetching: results.some((result) => result.isFetching),
        error: results.find((result) => result.error)?.error ?? null,
        refetch: () => Promise.all(results.map((result) => result.refetch())),
      };
    },
  });
}

/** Manual retry (manager+): resets automation's attempt counter and processes the statement now. */
export function useRetryAutomationStatement(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statementId: string) =>
      api.post<StatementAutomationRecord>(`${root(orgId)}/statements/${encodeURIComponent(statementId)}/retry`),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: automationKeys.statementsRoot(orgId) }),
        qc.invalidateQueries({ queryKey: royaltyKeys.statements(orgId) }),
      ]),
  });
}

// ----------------------------------------------------------------- inbox files (admin)

export function useAutomationInboxFiles(orgId: string, params: InboxFileListParams, { enabled = true }: AdminQueryOptions = {}) {
  return useQuery({
    queryKey: automationKeys.inboxFiles(orgId, params),
    queryFn: ({ signal }) => api.get<InboxFileOutcome[]>(`${root(orgId)}/inbox-files`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ----------------------------------------------------------------- review queue (viewer / manager)

export function useReviewTasks(orgId: string, params: ReviewTaskListParams) {
  return useQuery({
    queryKey: automationKeys.reviewTasks(orgId, params),
    queryFn: ({ signal }) => api.get<ReviewTask[]>(`${root(orgId)}/review-tasks`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });
}

export type ReviewTaskAction = "resolve" | "dismiss";

export function useCloseReviewTask(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, action, note }: { taskId: string; action: ReviewTaskAction; note?: string | null }) =>
      api.post<ReviewTask>(`${root(orgId)}/review-tasks/${encodeURIComponent(taskId)}/${action}`, {
        body: { note: note?.trim() ? note.trim() : null },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}

/** Queue an automated (AI-assisted) review of a catalog item or rights conflict (manager+). */
export function useRequestAutomatedReview(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { subject_type: ReviewSubjectType; subject_id: string }) =>
      api.post<ReviewRequestResult>(`${root(orgId)}/review-requests`, { body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.all(orgId) }),
  });
}
