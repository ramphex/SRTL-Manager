import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { JobRecord } from "../shared/types";
import { api } from "./api";

const finishedStatuses: ReadonlySet<JobRecord["status"]> = new Set(["completed", "partially_failed", "failed", "cancelled"]);

export function jobFinished(job: Pick<JobRecord, "status"> | null | undefined): boolean {
  return Boolean(job && finishedStatuses.has(job.status));
}

/**
 * Follows a job this page queued until it finishes, and calls `onFinished`
 * once when it does. File changes run in the worker, so a page that starts
 * one shows its job rather than a result.
 */
export function useQueuedJob(jobId: number | null, onFinished?: (job: JobRecord) => void) {
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => (jobFinished(query.state.data) ? false : 1500)
  });
  const reported = useRef<number | null>(null);
  const finishedCallback = useRef(onFinished);
  useEffect(() => {
    finishedCallback.current = onFinished;
  });
  useEffect(() => {
    const data = job.data;
    if (!data || !jobFinished(data) || reported.current === data.id) return;
    reported.current = data.id;
    finishedCallback.current?.(data);
  }, [job.data]);
  return job;
}
