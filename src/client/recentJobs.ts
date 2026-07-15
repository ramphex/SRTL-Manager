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

export function visibleDashboardJobs(jobs: JobRecord[], completedWindowMinutes: number, now: Date = new Date()): JobRecord[] {
  const normalizedWindowMinutes = normalizeRecentJobsCompletedWindowMinutes(completedWindowMinutes);
  const cutoffMs = now.getTime() - normalizedWindowMinutes * 60 * 1000;
  const visibleJobs = jobs.filter((job) => {
    if (isActiveDashboardJob(job)) return true;
    if (!job.finishedAt) return false;
    const finishedAtMs = Date.parse(job.finishedAt);
    return Number.isFinite(finishedAtMs) && finishedAtMs >= cutoffMs;
  });
  return visibleJobs.sort((a, b) => {
    const activeDelta = Number(isActiveDashboardJob(b)) - Number(isActiveDashboardJob(a));
    if (activeDelta !== 0) return activeDelta;
    return b.id - a.id;
  });
}
