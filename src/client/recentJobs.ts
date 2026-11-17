import type { JobRecord } from "../shared/types";

export const defaultRecentJobsCompletedWindowMinutes = 24 * 60;

export const recentJobsCompletedWindowOptions = [
  { value: 15, label: "15 min" },
  { value: 60, label: "1 hour" },
  { value: 6 * 60, label: "6 hours" },
  { value: 24 * 60, label: "24 hours" },
  { value: 7 * 24 * 60, label: "7 days" }
] as const;

const allowedRecentJobWindows = new Set<number>(recentJobsCompletedWindowOptions.map((option) => option.value));

export function normalizeRecentJobsCompletedWindowMinutes(value: unknown): number {
  return typeof value === "number" && allowedRecentJobWindows.has(value) ? value : defaultRecentJobsCompletedWindowMinutes;
}

export function isActiveDashboardJob(job: JobRecord): boolean {
  return job.status === "queued" || job.status === "running";
}

export function inventoryJobRefreshKey(jobs: JobRecord[]): string {
  return jobs
    .filter((job) => (job.type === "scan" || job.type === "copy") && Boolean(job.finishedAt))
    .map((job) => `${job.id}:${job.status}:${job.finishedAt}`)
    .sort()
    .join("|");
}
