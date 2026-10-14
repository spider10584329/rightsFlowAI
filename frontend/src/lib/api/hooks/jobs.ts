"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { Page, Schemas } from "@/lib/api/types";

export type Job = Schemas["JobResponse"];
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

/** True while the job may still change on its own. */
export function isJobActive(job: Pick<Job, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export const JOB_POLL_MS = 3000;

export const jobKeys = {
  all: (orgId: string) => ["org", orgId, "jobs"] as const,
  list: (orgId: string, params: object) => ["org", orgId, "jobs", "list", params] as const,
  detail: (orgId: string, jobId: string) => ["org", orgId, "jobs", "detail", jobId] as const,
};

export interface JobListParams {
  page: number;
  page_size: number;
  sort?: string;
  order?: "asc" | "desc";
  status?: JobStatus;
  job_type?: string;
}

export function useJobs(orgId: string, params: JobListParams) {
  return useQuery({
    queryKey: jobKeys.list(orgId, params),
    queryFn: ({ signal }) => api.get<Page<Job>>(`/organizations/${orgId}/jobs`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
    // Poll only while something on this page is still queued or running.
    refetchInterval: (query) => (query.state.data?.items.some(isJobActive) ? JOB_POLL_MS : false),
  });
}

export function useJob(orgId: string, jobId: string | null) {
  return useQuery({
    queryKey: jobKeys.detail(orgId, jobId ?? ""),
    queryFn: ({ signal }) => api.get<Job>(`/organizations/${orgId}/jobs/${jobId}`, { signal }),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data && isJobActive(query.state.data) ? JOB_POLL_MS : false),
  });
}

function useJobAction(orgId: string, action: "cancel" | "retry") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post<Job>(`/organizations/${orgId}/jobs/${jobId}/${action}`),
    onSuccess: (job) => qc.setQueryData(jobKeys.detail(orgId, job.id), job),
    onSettled: () => qc.invalidateQueries({ queryKey: jobKeys.all(orgId) }),
  });
}

export function useCancelJob(orgId: string) {
  return useJobAction(orgId, "cancel");
}

export function useRetryJob(orgId: string) {
  return useJobAction(orgId, "retry");
}
